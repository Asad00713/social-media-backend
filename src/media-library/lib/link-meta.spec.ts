import * as http from 'http';
import type { AddressInfo } from 'net';
import { fetch as undiciFetch } from 'undici';
import {
  checkedLookup,
  extractFavicon,
  normalizeUtm,
  isPrivateAddress,
  assertPublicUrl,
  fetchPublicHtml,
} from './link-meta';

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn(actual.fetch) };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- requireActual is untyped under this jest config
const realUndiciFetch = jest.requireActual('undici').fetch as never;

describe('extractFavicon', () => {
  it('resolves a root-relative icon', () => {
    expect(
      extractFavicon(
        '<link rel="icon" href="/favicon.png">',
        'https://a.com/x',
      ),
    ).toBe('https://a.com/favicon.png');
  });
  it('keeps an absolute href with attributes in any order', () => {
    expect(
      extractFavicon(
        '<link href="https://cdn.a.com/i.ico" rel="shortcut icon">',
        'https://a.com/x',
      ),
    ).toBe('https://cdn.a.com/i.ico');
  });
  it('resolves an apple-touch-icon relative to the page', () => {
    expect(
      extractFavicon(
        '<link rel="apple-touch-icon" href="t.png">',
        'https://a.com/b/c',
      ),
    ).toBe('https://a.com/b/t.png');
  });
  it.each([
    [
      '<link rel="apple-touch-icon" href="/t.png"><link rel="icon" href="/i.png">',
    ],
    [
      '<link rel="icon" href="/i.png"><link rel="apple-touch-icon" href="/t.png">',
    ],
  ])('prefers the icon over apple-touch in either order', (html) => {
    expect(extractFavicon(html, 'https://a.com/')).toBe('https://a.com/i.png');
  });
  it('falls back to /favicon.ico', () => {
    expect(extractFavicon('<html></html>', 'https://a.com/p')).toBe(
      'https://a.com/favicon.ico',
    );
  });
  it('ignores data: and non-http hrefs', () => {
    expect(
      extractFavicon(
        '<link rel="icon" href="data:image/png;base64,AAA"><link rel="icon" href="javascript:x">',
        'https://a.com/p',
      ),
    ).toBe('https://a.com/favicon.ico');
  });
});

describe('normalizeUtm', () => {
  it('trims and drops empties', () => {
    expect(normalizeUtm({ source: ' ig ', medium: '', campaign: 'x' })).toEqual(
      { source: 'ig', campaign: 'x' },
    );
  });
  it('returns null when nothing is left', () => {
    expect(normalizeUtm({ medium: '' })).toBeNull();
    expect(normalizeUtm(null)).toBeNull();
    expect(normalizeUtm(undefined)).toBeNull();
  });
});

describe('extractFavicon hostile input', () => {
  it('scans a pathological 1 MB "<link" with no ">" in linear time', () => {
    const html = '<link '.repeat(Math.floor((1024 * 1024) / 6));
    const start = Date.now();
    extractFavicon(html, 'https://a.com/');
    expect(Date.now() - start).toBeLessThan(200);
  });
  it('ignores icons that appear after </head>', () => {
    expect(
      extractFavicon(
        '<head></head><body><link rel="icon" href="/late.png"></body>',
        'https://a.com/',
      ),
    ).toBe('https://a.com/favicon.ico');
  });
});

type CbFn = (err: Error | null, addrs: unknown[]) => void;

describe('SSRF guard', () => {
  beforeEach(() => mockedFetch.mockReset());

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    'not-an-ip',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
  it('rejects non-http schemes and private literals', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(
      assertPublicUrl('http://169.254.169.254/latest'),
    ).rejects.toThrow();
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow();
    await expect(
      assertPublicUrl('http://[::ffff:127.0.0.1]/'),
    ).rejects.toThrow();
  });

  it('never reaches a loopback server through a mapped IPv6 literal', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('secret');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    mockedFetch.mockImplementation(realUndiciFetch);
    try {
      await expect(
        fetchPublicHtml(`http://[::ffff:127.0.0.1]:${port}/`, {}),
      ).rejects.toThrow();
      await expect(
        fetchPublicHtml(`http://[::ffff:7f00:1]:${port}/`, {}),
      ).rejects.toThrow();
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('connect-time lookup rejects when any resolved address is private (rebinding)', async () => {
    const answers = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
    ];
    const resolver = jest
      .fn()
      .mockImplementationOnce((_h: string, _o: unknown, cb: CbFn) =>
        cb(null, answers[0]),
      )
      .mockImplementationOnce((_h: string, _o: unknown, cb: CbFn) =>
        cb(null, answers[1]),
      );
    const run = () =>
      new Promise<unknown>((res) =>
        checkedLookup(
          'x.test',
          {},
          (err, addrs) => res(err ?? addrs),
          resolver,
        ),
      );
    expect(await run()).toEqual(answers[0]);
    expect(await run()).toBeInstanceOf(Error);
  });

  it('does not fetch a private target, nor follow a redirect into one', async () => {
    mockedFetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    );
    await expect(fetchPublicHtml('http://10.0.0.1/', {})).rejects.toThrow();
    expect(mockedFetch).not.toHaveBeenCalled();
    await expect(fetchPublicHtml('http://8.8.8.8/', {})).rejects.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 redirects', async () => {
    mockedFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://8.8.4.4/next' },
        }),
      ),
    );
    expect(await fetchPublicHtml('http://8.8.8.8/', {})).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it.each(['file:///etc/passwd', 'gopher://8.8.8.8/'])(
    'refuses a redirect to %s',
    async (location) => {
      mockedFetch.mockResolvedValue(
        new Response(null, { status: 302, headers: { location } }),
      );
      const r = await fetchPublicHtml('http://8.8.8.8/', {}).catch(() => null);
      expect(r).toBeNull();
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels the body of a non-ok response and returns null', async () => {
    const res = new Response('nope', { status: 500 });
    const cancel = jest.spyOn(res.body!, 'cancel');
    mockedFetch.mockResolvedValue(res);
    expect(await fetchPublicHtml('http://8.8.8.8/', {})).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('uses one 8s deadline signal for the whole redirect chain', async () => {
    const spy = jest.spyOn(AbortSignal, 'timeout');
    mockedFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://8.8.4.4/next' },
        }),
      ),
    );
    await fetchPublicHtml('http://8.8.8.8/', {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(8000);
    const calls = mockedFetch.mock.calls as [string, { signal: AbortSignal }][];
    const signals = calls.map((c) => c[1].signal);
    expect(new Set(signals).size).toBe(1);
    spy.mockRestore();
  });

  it('aborts a hung fetch once the deadline signal fires', async () => {
    const ctl = new AbortController();
    const spy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(ctl.signal);
    mockedFetch.mockImplementation(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          if (init.signal.aborted) return rej(new Error('deadline'));
          init.signal.addEventListener('abort', () =>
            rej(new Error('deadline')),
          );
        }),
    );
    const pending = expect(
      fetchPublicHtml('http://8.8.8.8/', {}),
    ).rejects.toThrow('deadline');
    ctl.abort();
    await pending;
    spy.mockRestore();
  });

  it('caps the body at 1 MB', async () => {
    mockedFetch.mockResolvedValue(new Response('x'.repeat(3 * 1024 * 1024)));
    const r = await fetchPublicHtml('http://8.8.8.8/', {});
    expect(r!.html.length).toBeLessThan(1.5 * 1024 * 1024);
  });
});
