import { redactTokenUrls } from './redact-token-urls';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ4In0.c2ln-_x';

describe('redactTokenUrls', () => {
  it.each([
    '/email/unsubscribe/',
    '/email/security/',
    '/reports/public/',
    '/reports/render/',
    '/reports/unsubscribe/',
  ])('replaces the token segment of %s', (prefix) => {
    expect(redactTokenUrls(`${prefix}${JWT}`)).toBe(`${prefix}[token]`);
  });

  it('keeps the query string and a trailing path', () => {
    expect(redactTokenUrls(`/email/unsubscribe/${JWT}?a=1&b=2`)).toBe(
      '/email/unsubscribe/[token]?a=1&b=2',
    );
    expect(redactTokenUrls(`/email/security/${JWT}/confirm#x`)).toBe(
      '/email/security/[token]/confirm#x',
    );
  });

  it('redacts a token inside a message and every occurrence', () => {
    expect(
      redactTokenUrls(
        `Cannot GET /email/unsubscribe/${JWT} (from /reports/public/abc-DEF_123)`,
      ),
    ).toBe(
      'Cannot GET /email/unsubscribe/[token] (from /reports/public/[token])',
    );
  });

  it('works behind a global prefix', () => {
    expect(redactTokenUrls(`/api/v1/email/unsubscribe/${JWT}`)).toBe(
      '/api/v1/email/unsubscribe/[token]',
    );
  });

  it('leaves every other url alone', () => {
    for (const url of [
      '/reports/abc/send',
      '/reports',
      '/email/webhooks/resend',
      '/email/unsubscribe/',
      '/auth/login?next=/reports/public',
      '/workspaces/ws1/posts/reports',
    ]) {
      expect(redactTokenUrls(url)).toBe(url);
    }
  });
});
