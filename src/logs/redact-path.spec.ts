import { redactSensitivePath } from './redact-path';

describe('redactSensitivePath', () => {
  const TOKEN = 'Zk3v_-Q9pLmN0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';

  it('replaces the connect link token and keeps the rest of the path', () => {
    expect(redactSensitivePath(`/public/connect-links/${TOKEN}`)).toBe(
      '/public/connect-links/[redacted]',
    );
    expect(
      redactSensitivePath(`/public/connect-links/${TOKEN}/instagram/start`),
    ).toBe('/public/connect-links/[redacted]/instagram/start');
  });

  it('keeps the query string', () => {
    expect(redactSensitivePath(`/public/connect-links/${TOKEN}?a=1`)).toBe(
      '/public/connect-links/[redacted]?a=1',
    );
  });

  it('redacts the Facebook selection id in the query of a connect link path', () => {
    const SEL = 'q7Yx2LmN0aBcDeFgHiJkLmNoPqRsTuVw';
    expect(
      redactSensitivePath(
        `/public/connect-links/${TOKEN}/facebook/pages?selection=${SEL}`,
      ),
    ).toBe(
      '/public/connect-links/[redacted]/facebook/pages?selection=[redacted]',
    );
    // wherever it sits in the query, and the other params stay
    expect(
      redactSensitivePath(
        `/public/connect-links/${TOKEN}/facebook/pages?a=1&selection=${SEL}&b=2`,
      ),
    ).toBe(
      '/public/connect-links/[redacted]/facebook/pages?a=1&selection=[redacted]&b=2',
    );
    // inside a message too (Nest's 404 spells the URL)
    const msg = redactSensitivePath(
      `Cannot GET /public/connect-links/${TOKEN}/facebook/pagez?selection=${SEL}`,
    );
    expect(msg).not.toContain(SEL);
    expect(msg).not.toContain(TOKEN);
  });

  it('leaves a selection param of other paths alone', () => {
    expect(redactSensitivePath('/workspaces/abc/posts?selection=3')).toBe(
      '/workspaces/abc/posts?selection=3',
    );
  });

  it('leaves other paths alone', () => {
    expect(redactSensitivePath('/workspaces/abc/connect-links')).toBe(
      '/workspaces/abc/connect-links',
    );
    expect(redactSensitivePath('/auth/me')).toBe('/auth/me');
  });
});
