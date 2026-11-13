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

  it('leaves other paths alone', () => {
    expect(redactSensitivePath('/workspaces/abc/connect-links')).toBe(
      '/workspaces/abc/connect-links',
    );
    expect(redactSensitivePath('/auth/me')).toBe('/auth/me');
  });
});
