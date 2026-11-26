// No real request may leave a test: both fetches are stubbed, though this
// helper never sends one.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));
beforeEach(() => {
  jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => jest.restoreAllMocks());

import { safeReturnUrl } from './oauth-return-url';

const ALLOWED = ['https://app.schedura.test', 'https://api.schedura.test'];
const FALLBACK = '/channels/connect/success';

describe('safeReturnUrl', () => {
  it.each([
    'https://app.schedura.test/channels?tab=connected',
    'https://app.schedura.test',
    'https://api.schedura.test/done',
  ])('keeps %s: one of our own origins', (url) => {
    expect(safeReturnUrl(url, FALLBACK, ALLOWED)).toBe(new URL(url).href);
  });

  it('returns the parsed URL, not the raw string', () => {
    expect(
      safeReturnUrl('HTTPS://APP.schedura.test/a b?x=1', FALLBACK, ALLOWED),
    ).toBe('https://app.schedura.test/a%20b?x=1');
    expect(safeReturnUrl('https://app.schedura.test', FALLBACK, ALLOWED)).toBe(
      'https://app.schedura.test/',
    );
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
