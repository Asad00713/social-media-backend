import { buildPoolConfig } from './pool-config';

describe('buildPoolConfig', () => {
  const INTERNAL = 'postgresql://u:p@postgres.railway.internal:5432/railway';
  const PUBLIC = 'postgresql://u:p@abc.proxy.rlwy.net:12345/railway';
  const SSLMODE = 'postgresql://u:p@somehost:5432/db?sslmode=require';
  const LOCAL = 'postgresql://u:p@localhost:5432/db';

  afterEach(() => {
    delete process.env.DATABASE_CA_CERT;
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
    expect(buildPoolConfig(PUBLIC).ssl).toEqual({
      ca: 'CERT-PEM',
      rejectUnauthorized: true,
    });
  });

  it('never disables certificate verification', () => {
    const ssl = buildPoolConfig(PUBLIC).ssl as { rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it('carries the connection string and a bounded pool size', () => {
    const cfg = buildPoolConfig(PUBLIC);
    expect(cfg.connectionString).toBe(PUBLIC);
    expect(cfg.max).toBe(10);
  });
});
