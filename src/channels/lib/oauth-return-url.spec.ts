import { safeReturnUrl } from './oauth-return-url';

const ALLOWED = ['https://app.schedura.test', 'https://api.schedura.test'];
const FALLBACK = '/channels/connect/success';

describe('safeReturnUrl', () => {
  it.each([
    'https://app.schedura.test/channels?tab=connected',
    'https://app.schedura.test',
    'https://api.schedura.test/done',
  ])('keeps %s: one of our own origins', (url) => {
    expect(safeReturnUrl(url, FALLBACK, ALLOWED)).toBe(url);
  });

  it.each([
    ['an evil origin', 'https://evil.example/phish'],
    ['a relative path', '/dashboard'],
    ['a scheme-relative URL', '//evil.com/phish'],
    ['a backslash trick', 'https:\\\\evil.com'],
    [
      'userinfo in front of an evil host',
      'https://app.schedura.test@evil.com/',
    ],
    ['a look-alike host', 'https://app.schedura.test.evil.com/'],
    ['our host on another port', 'https://app.schedura.test:8443/'],
    ['our host over plain http', 'http://app.schedura.test/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
    ['nothing', null],
    ['an empty string', ''],
  ])('falls back for %s', (_what, url) => {
    expect(safeReturnUrl(url, FALLBACK, ALLOWED)).toBe(FALLBACK);
  });

  it('falls back when no origin is configured', () => {
    expect(
      safeReturnUrl('https://app.schedura.test/x', FALLBACK, [undefined, '']),
    ).toBe(FALLBACK);
  });

  it('ignores a configured value that is not a URL', () => {
    expect(
      safeReturnUrl('https://app.schedura.test/x', FALLBACK, [
        'not a url',
        'https://app.schedura.test/',
      ]),
    ).toBe('https://app.schedura.test/x');
  });
});
