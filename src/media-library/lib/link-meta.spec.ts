import {
  extractFavicon,
  normalizeUtm,
  isPrivateAddress,
  assertPublicUrl,
  fetchPublicHtml,
} from './link-meta';

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

describe('SSRF guard', () => {
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
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it('treats public addresses as public', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1::1')).toBe(false);
  });
  it('rejects non-http schemes and private literals', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(
      assertPublicUrl('http://169.254.169.254/latest'),
    ).rejects.toThrow();
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow();
  });
  it('does not fetch a private target, nor follow a redirect into one', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    );
    const original = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(fetchPublicHtml('http://10.0.0.1/', {})).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(
        fetchPublicHtml('http://93.184.216.34/', {}),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = original;
    }
  });
  it('caps the body at 1 MB', async () => {
    const original = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('x'.repeat(3 * 1024 * 1024)),
      ) as unknown as typeof fetch;
    try {
      const r = await fetchPublicHtml('http://93.184.216.34/', {});
      expect(r!.html.length).toBeLessThan(1.5 * 1024 * 1024);
    } finally {
      global.fetch = original;
    }
  });
});
