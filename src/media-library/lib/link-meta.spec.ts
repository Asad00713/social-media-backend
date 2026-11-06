import * as http from 'http';
import type { AddressInfo } from 'net';
import { fetch as undiciFetch } from 'undici';
import {
  checkedLookup,
  extractFavicon,
  extractPageMeta,
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
    '198.18.0.1',
    '198.19.255.255',
    '64:ff9b:1::1',
    'fec0::1',
    '100::1',
    '192.0.0.8',
    '192.0.2.5',
    '198.51.100.7',
    '203.0.113.9',
    '240.0.0.1',
    '255.255.255.254',
    '2001:db8::1',
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
          { all: true },
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

  it('cancels the body on the redirect path too', async () => {
    const res = new Response('r', {
      status: 302,
      headers: { location: 'http://8.8.4.4/n' },
    });
    const cancel = jest.spyOn(res.body!, 'cancel');
    mockedFetch.mockResolvedValueOnce(res);
    mockedFetch.mockResolvedValueOnce(new Response('ok'));
    await fetchPublicHtml('http://8.8.8.8/', {});
    expect(cancel).toHaveBeenCalled();
  });

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

describe('extractPageMeta', () => {
  const U = 'https://a.com/p';
  it('reads og tags with content before property', () => {
    const m = extractPageMeta(
      '<head><meta content="T" property="og:title"><meta content="D" name="description"></head>',
      U,
    );
    expect(m.title).toBe('T');
    expect(m.description).toBe('D');
  });
  it('reads single-quoted and unquoted values, og over fallback', () => {
    const m = extractPageMeta(
      "<head><title>Fallback</title><meta property='og:title' content='Q'><meta property=og:site_name content=Site><meta property=og:image content=/i.png></head>",
      U,
    );
    expect(m.title).toBe('Q');
    expect(m.siteName).toBe('Site');
    expect(m.imageUrl).toBe('/i.png');
  });
  it('reads an upper-case <TITLE> and decodes entities', () => {
    const m = extractPageMeta(
      '<HEAD><TITLE>A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#x27;</TITLE></HEAD>',
      U,
    );
    expect(m.title).toBe('A & B <c> "d" \'e\'');
  });
  it('decodes entities in meta content', () => {
    const m = extractPageMeta(
      '<meta property="og:description" content="Tom &amp; Jerry">',
      U,
    );
    expect(m.description).toBe('Tom & Jerry');
  });
  it('scans a pathological 32 KB og:title input in linear time', () => {
    const html = '<meta property="og:title"'.repeat(
      Math.floor((32 * 1024) / 25),
    );
    const start = Date.now();
    extractPageMeta(html, U);
    expect(Date.now() - start).toBeLessThan(200);
  });
  it('scans only the first 64 KB when there is no </head>', () => {
    const html =
      'x'.repeat(70 * 1024) + '<meta property="og:title" content="late">';
    expect(extractPageMeta(html, U).title).toBeUndefined();
  });
  it('stops at </head>', () => {
    const m = extractPageMeta(
      '<head></head><meta property="og:title" content="late">',
      U,
    );
    expect(m.title).toBeUndefined();
  });
});

describe('quoted ">" inside attribute values', () => {
  const U = 'https://a.com/p';
  it('keeps a ">" in content when property comes first', () => {
    const m = extractPageMeta(
      '<meta property="og:description" content="Home > Shop">',
      U,
    );
    expect(m.description).toBe('Home > Shop');
  });
  it('keeps a ">" in content when content comes first', () => {
    const m = extractPageMeta(
      '<meta content="Home > Shop" property="og:description">',
      U,
    );
    expect(m.description).toBe('Home > Shop');
  });
  it('handles a ">" inside a single-quoted value', () => {
    const m = extractPageMeta("<meta content='a > b' property='og:title'>", U);
    expect(m.title).toBe('a > b');
  });
  it('an unclosed quote ends the tag at the next ">" and never runs past the cap', () => {
    const m = extractPageMeta(
      '<meta property="og:title" content="oops>' +
        "<meta property='og:site_name' content='Site'>",
      U,
    );
    expect(m.siteName).toBe('Site');
  });
  it('is linear on 1 MB of unclosed quotes and of quoted ">"', () => {
    for (const unit of ['<meta content="', '<meta content="a>b" x=']) {
      const html = unit.repeat(Math.floor((1024 * 1024) / unit.length));
      const start = Date.now();
      extractPageMeta(html, U);
      expect(Date.now() - start).toBeLessThan(200);
    }
  });
});

describe('extractFavicon offsets', () => {
  it('survives a capital I with dot above (lowercase changes length)', () => {
    expect(
      extractFavicon(
        'İ'.repeat(10) + '<link rel="icon" href="/i.png">',
        'https://a.com/',
      ),
    ).toBe('https://a.com/i.png');
  });
});

describe('checkedLookup options.all', () => {
  const resolver = (
    _h: string,
    _o: unknown,
    cb: (e: Error | null, a: { address: string; family: number }[]) => void,
  ) =>
    cb(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  it('returns the array when all is true', () => {
    const cb = jest.fn();
    checkedLookup('x', { all: true }, cb, resolver as never);
    expect(cb).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });
  it('returns (null, address, family) when all is false', () => {
    const cb = jest.fn();
    checkedLookup('x', {}, cb, resolver as never);
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
});
