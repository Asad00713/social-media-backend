import { DEFAULT_POOL_MAX, buildPoolConfig } from './pool-config';

describe('buildPoolConfig', () => {
  const INTERNAL = 'postgresql://u:p@postgres.railway.internal:5432/railway';
  const PUBLIC = 'postgresql://u:p@abc.proxy.rlwy.net:12345/railway';
  const SSLMODE = 'postgresql://u:p@somehost:5432/db?sslmode=require';
  const LOCAL = 'postgresql://u:p@localhost:5432/db';

  afterEach(() => {
    delete process.env.DATABASE_CA_CERT;
    delete process.env.DB_POOL_MAX;
  });

  it('disables TLS for the Railway internal (private network) host', () => {
    expect(buildPoolConfig(INTERNAL).ssl).toBe(false);
  });

  it('disables TLS for a plain localhost connection', () => {
    expect(buildPoolConfig(LOCAL).ssl).toBe(false);
  });

  it('enables verified TLS for the Railway public proxy host', () => {
    expect(buildPoolConfig(PUBLIC).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('enables verified TLS when the URL carries sslmode=require', () => {
    expect(buildPoolConfig(SSLMODE).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('includes the CA when DATABASE_CA_CERT is set (still verified)', () => {
    process.env.DATABASE_CA_CERT = 'CERT-PEM';
    const ssl = buildPoolConfig(PUBLIC).ssl as {
      ca?: string;
      rejectUnauthorized?: boolean;
    };
    expect(ssl.ca).toBe('CERT-PEM');
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  /**
   * verify-ca mode: the chain is verified against the pinned CA, and only the
   * hostname check is skipped (Railway's cert is issued for the database
   * instance, not the proxy host). Asserted explicitly because the pair is
   * what makes it verify-ca rather than either full verification or none —
   * and because a `toEqual` on the whole object silently went stale when this
   * was added.
   */
  it('skips only the hostname check when a CA is pinned, keeping the chain verified', () => {
    process.env.DATABASE_CA_CERT = 'CERT-PEM';
    const ssl = buildPoolConfig(PUBLIC).ssl as {
      rejectUnauthorized?: boolean;
      checkServerIdentity?: () => undefined;
    };
    expect(typeof ssl.checkServerIdentity).toBe('function');
    expect(ssl.checkServerIdentity?.()).toBeUndefined();
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it('does not skip the hostname check when no CA is pinned', () => {
    const ssl = buildPoolConfig(PUBLIC).ssl as {
      checkServerIdentity?: unknown;
    };
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it('never disables certificate verification', () => {
    const ssl = buildPoolConfig(PUBLIC).ssl as { rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it('carries the connection string and a bounded pool size', () => {
    const cfg = buildPoolConfig(PUBLIC);
    expect(cfg.connectionString).toBe(PUBLIC);
    expect(cfg.max).toBe(DEFAULT_POOL_MAX);
  });

  describe('DB_POOL_MAX', () => {
    it('raises the pool ceiling when set', () => {
      process.env.DB_POOL_MAX = '25';
      expect(buildPoolConfig(PUBLIC).max).toBe(25);
    });

    /**
     * A typo in a Railway variable must not produce a pool of 0 (every query
     * waits forever) or NaN (node-postgres reads it as unbounded, which would
     * exhaust Postgres' max_connections under load). Both are worse outcomes
     * than ignoring the value, so each bad shape falls back to the default.
     */
    it.each([
      ['not a number', 'ten'],
      ['zero', '0'],
      ['negative', '-5'],
      ['fractional', '7.5'],
      ['empty', ''],
    ])('ignores a %s value and keeps the default', (_label, value) => {
      process.env.DB_POOL_MAX = value;
      expect(buildPoolConfig(PUBLIC).max).toBe(DEFAULT_POOL_MAX);
    });
  });

  it('disables TLS for an arbitrary non-Railway host without sslmode', () => {
    expect(buildPoolConfig('postgresql://u:p@db.example.com:5432/db').ssl).toBe(
      false,
    );
  });
});
