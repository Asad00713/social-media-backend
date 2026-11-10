import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_PATTERN,
  checkTargetUrl,
  generateCode,
  isSafeRedirectTarget,
  selfLinkBases,
  shortLinkBaseUrl,
} from './short-link-rules';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

describe('generateCode', () => {
  it('draws CODE_LENGTH base62 characters from the picker', () => {
    const seen: number[] = [];
    const code = generateCode((max) => {
      seen.push(max);
      return (seen.length * 9) % max;
    });
    expect(code).toHaveLength(CODE_LENGTH);
    expect(seen).toEqual(Array(CODE_LENGTH).fill(62));
    expect(code).toBe('9IRajs1');
    expect(CODE_PATTERN.test(code)).toBe(true);
  });

  it('uses the first and last alphabet characters', () => {
    expect(generateCode(() => 0)).toBe('0'.repeat(CODE_LENGTH));
    expect(generateCode(() => 61)).toBe('z'.repeat(CODE_LENGTH));
    expect(CODE_ALPHABET).toHaveLength(62);
  });

  it('is random by default', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(CODE_PATTERN.test(c)).toBe(true);
  });
});

describe('shortLinkBaseUrl', () => {
  it('prefers SHORT_LINK_BASE_URL, without a trailing slash', () => {
    expect(
      shortLinkBaseUrl(
        env({
          SHORT_LINK_BASE_URL: 'https://sched.ly/',
          API_PUBLIC_URL: 'https://api.schedura.ai',
        }),
      ),
    ).toBe('https://sched.ly');
  });

  it('falls back to API_PUBLIC_URL, then APP_URL, plus /l', () => {
    expect(
      shortLinkBaseUrl(
        env({ API_PUBLIC_URL: 'https://api.schedura.ai/', APP_URL: 'x' }),
      ),
    ).toBe('https://api.schedura.ai/l');
    expect(shortLinkBaseUrl(env({ APP_URL: 'http://localhost:8000' }))).toBe(
      'http://localhost:8000/l',
    );
  });

  it('is null when nothing usable is configured', () => {
    expect(shortLinkBaseUrl(env({}))).toBeNull();
    expect(
      shortLinkBaseUrl(env({ SHORT_LINK_BASE_URL: 'ftp://x.test' })),
    ).toBeNull();
    expect(shortLinkBaseUrl(env({ APP_URL: 'not a url' }))).toBeNull();
  });

  it('selfLinkBases holds the custom domain AND the API /l', () => {
    expect(
      selfLinkBases(
        env({
          SHORT_LINK_BASE_URL: 'https://sched.ly',
          API_PUBLIC_URL: 'https://api.schedura.ai',
        }),
      ),
    ).toEqual(['https://sched.ly', 'https://api.schedura.ai/l']);
    expect(selfLinkBases(env({ APP_URL: 'http://localhost:8000' }))).toEqual([
      'http://localhost:8000/l',
    ]);
  });
});

describe('checkTargetUrl', () => {
  const bases = ['https://api.schedura.ai/l', 'https://sched.ly'];

  it('accepts http and https, normalised', () => {
    expect(checkTargetUrl('  HTTPS://Lumiere.PK/menu?a=1#x ', bases)).toEqual({
      ok: true,
      url: 'https://lumiere.pk/menu?a=1#x',
    });
    expect(checkTargetUrl('http://x.test', bases)).toEqual({
      ok: true,
      url: 'http://x.test/',
    });
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['JaVaScRiPt:alert(1)', 'scheme'],
    ['data:text/html,<script>1</script>', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['ftp://x.test/a', 'scheme'],
    ['www.x.test', 'invalid'],
    ['not a url', 'invalid'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://user:pw@x.test/', 'credentials'],
    ['https://bank.test@evil.test/', 'credentials'],
  ])('refuses %s (%s)', (input, problem) => {
    expect(checkTargetUrl(input, bases)).toEqual({ ok: false, problem });
  });

  it('refuses a non-string', () => {
    expect(checkTargetUrl(42, bases)).toEqual({ ok: false, problem: 'empty' });
  });

  it('refuses our own short URLs, under either base', () => {
    expect(checkTargetUrl('https://api.schedura.ai/l/abc1234', bases)).toEqual({
      ok: false,
      problem: 'self',
    });
    expect(checkTargetUrl('https://API.schedura.ai/l/x', bases)).toEqual({
      ok: false,
      problem: 'self',
    });
    expect(checkTargetUrl('https://sched.ly/abc1234', bases)).toEqual({
      ok: false,
      problem: 'self',
    });
  });

  it('allows other paths on the API host, and lookalike hosts', () => {
    expect(checkTargetUrl('https://api.schedura.ai/lx/1', bases).ok).toBe(true);
    expect(checkTargetUrl('https://api.schedura.ai/', bases).ok).toBe(true);
    expect(checkTargetUrl('https://sched.ly.evil.test/a', bases).ok).toBe(true);
  });

  it('refuses a port-different self host only when the port matches', () => {
    const local = ['http://localhost:8000/l'];
    expect(checkTargetUrl('http://localhost:8000/l/abc', local).ok).toBe(false);
    expect(checkTargetUrl('http://localhost:3002/l/abc', local).ok).toBe(true);
  });

  it('caps the length at 2048, before and after normalising', () => {
    const at = `https://x.test/${'a'.repeat(2048 - 15)}`;
    expect(at).toHaveLength(2048);
    expect(checkTargetUrl(at, bases).ok).toBe(true);
    expect(checkTargetUrl(`${at}b`, bases)).toEqual({
      ok: false,
      problem: 'too_long',
    });
    // Each space becomes %20 when normalised: 3x longer.
    const grows = `https://x.test/${' '.repeat(1000)}a`;
    expect(checkTargetUrl(grows, bases)).toEqual({
      ok: false,
      problem: 'too_long',
    });
  });
});

describe('isSafeRedirectTarget', () => {
  it('only http(s)', () => {
    expect(isSafeRedirectTarget('https://x.test/')).toBe(true);
    expect(isSafeRedirectTarget('http://x.test/')).toBe(true);
    expect(isSafeRedirectTarget('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirectTarget('nonsense')).toBe(false);
  });
});
