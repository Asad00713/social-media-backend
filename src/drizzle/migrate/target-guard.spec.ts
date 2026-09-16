import { decideTarget, hostOf, parseUpto } from './target-guard';

const LOCAL = 'postgresql://u:p@localhost:5432/schedura';
const RAILWAY_INTERNAL = 'postgresql://u:p@postgres.railway.internal:5432/railway';
// The shape sitting commented-out in this repo's .env, one character from live.
const RAILWAY_PUBLIC = 'postgresql://u:p@thomas.proxy.rlwy.net:44955/railway';

describe('decideTarget', () => {
  it('allows localhost without any confirmation', () => {
    expect(decideTarget(LOCAL, false).allowed).toBe(true);
  });

  it('allows the deploy-internal network — this must not break the container', () => {
    expect(decideTarget(RAILWAY_INTERNAL, false).allowed).toBe(true);
  });

  it('REFUSES a public production proxy when unconfirmed', () => {
    const d = decideTarget(RAILWAY_PUBLIC, false);
    expect(d.allowed).toBe(false);
    expect(d.host).toBe('thomas.proxy.rlwy.net');
    expect(d.reason).toMatch(/--i-know-this-is-production/);
  });

  it('allows a public production proxy only with the explicit flag', () => {
    expect(decideTarget(RAILWAY_PUBLIC, true).allowed).toBe(true);
  });

  it('refuses an unparseable URL rather than guessing', () => {
    expect(decideTarget('not-a-url', false).allowed).toBe(false);
  });

  it('reads the host out of a connection string', () => {
    expect(hostOf(RAILWAY_PUBLIC)).toBe('thomas.proxy.rlwy.net');
  });
});

describe('parseUpto', () => {
  it('accepts the space-separated form', () => {
    expect(parseUpto(['--upto', '0035_error_logs.sql'])).toBe(
      '0035_error_logs.sql',
    );
  });

  it('accepts the = form, which previously looked valid but was ignored', () => {
    expect(parseUpto(['--upto=0035_error_logs.sql'])).toBe(
      '0035_error_logs.sql',
    );
  });

  it('returns null when absent, so the caller can refuse to run', () => {
    expect(parseUpto([])).toBeNull();
    expect(parseUpto(['--upto'])).toBeNull();
  });
});
