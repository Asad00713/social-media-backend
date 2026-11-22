import type { PoolClient } from 'pg';
import { JwtService } from '@nestjs/jwt';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { SessionIssuer } from '../session/session-issuer';
import { SessionStore } from '../session/session-store';
import { SecondFactorService } from './second-factor.service';
import { TwoFactorService } from './two-factor.service';

// 0070/0072: users.sessions_revoked_at and known_devices (revokeOthers writes
// both). 0092: users.deleted_at, which the issuer reads. 0098/0099:
// user_sessions and the two-step columns.
const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0072_known_devices.sql',
  '0092_user_account_settings.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
  '0100_mfa_lock_escalation.sql',
];
const SECRETS: Record<string, string> = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
type ReplaceArgs = Parameters<SecondFactorService['replaceBackupCodes']>;
const rand = () => Math.random().toString(36).slice(2, 10);

/** A Google-only account: no password, verified, two-step off. */
async function seedGoogleUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, google_sub, is_email_verified)
     VALUES ($1, 'Google Only', $2, true) RETURNING id`,
    [`tf-${rand()}@example.test`, `g-${rand()}`],
  );
  return r.rows[0].id;
}

function request(): never {
  return {
    cookies: {},
    headers: { 'user-agent': UA, 'x-real-ip': '203.0.113.7' },
    ip: '10.0.0.1',
  } as never;
}

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

/** The real store, issuer and settings service on the harness connection. */
function build(
  db: DbType,
  secondFactor: Pick<
    SecondFactorService,
    'check' | 'replaceBackupCodes'
  > = new SecondFactorService(db),
) {
  const sessions = new SessionStore(db, { forget: jest.fn() } as never);
  const issuer = new SessionIssuer(
    db,
    new JwtService({}),
    { get: (key: string) => SECRETS[key] } as never,
    sessions,
    {
      track: jest.fn(),
      isMfaTrusted: jest.fn(),
      markMfaTrusted: jest.fn(),
    } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { lookup: jest.fn().mockResolvedValue(null) } as never,
    { create: jest.fn() } as never,
  );
  const notices = {
    enabled: jest.fn().mockResolvedValue(undefined),
    disabled: jest.fn().mockResolvedValue(undefined),
    regenerated: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TwoFactorService(
    db,
    secondFactor as SecondFactorService,
    sessions,
    issuer,
    notices as never,
  );
  return { service, issuer, sessions };
}

describeDb('TwoFactorService (database)', () => {
  const savedKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    // A throwaway key for the pending secret setup encrypts; never .env.
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  });

  it('a session made from a pre-deploy (sid-less) refresh token is no fresh sign-in: Google-only setup → 403 REAUTH_REQUIRED', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const { service, issuer } = build(db);

      // The old token was issued 3 days ago; the refresh happens now.
      const iat = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
      const legacy = await issuer.issue(
        userId,
        request(),
        response() as never,
        {
          via: 'refresh',
          sid: null,
          legacyIssuedAt: iat,
        },
      );
      const row = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM user_sessions WHERE id = $1`,
        [legacy.sid],
      );
      expect(row.rows[0].created_at.getTime()).toBe(iat * 1000);

      await expect(
        service.setup({ userId, sid: legacy.sid }, {}),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'REAUTH_REQUIRED' },
      });

      // Control: a real Google sign-in a moment ago passes.
      const fresh = await issuer.issue(userId, request(), response() as never, {
        via: 'google',
      });
      expect(fresh.kind).toBe('session');
      await expect(
        service.setup({ userId, sid: (fresh as { sid: string }).sid }, {}),
      ).resolves.toMatchObject({
        otpauthUrl: expect.stringMatching(/^otpauth:/) as unknown as string,
      });
    });
  });

  it('enable promotes only the pending secret the code was checked against: a setup restarted meanwhile → MFA_SETUP_MISSING, nothing enabled', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const sid = (
        await client.query<{ id: string }>(
          `INSERT INTO user_sessions (user_id, label, device_type, expires_at)
           VALUES ($1, 'Chrome on Windows', 'desktop', now() + interval '30 days')
           RETURNING id`,
          [userId],
        )
      ).rows[0].id;
      await client.query(
        `UPDATE users SET totp_pending_secret_enc = 'pending-A' WHERE id = $1`,
        [userId],
      );
      const real = new SecondFactorService(db);
      // The code is right for A; while it is judged, a second tab's setup
      // writes pending B.
      const racing = {
        check: jest.fn(async () => {
          await client.query(
            `UPDATE users SET totp_pending_secret_enc = 'pending-B' WHERE id = $1`,
            [userId],
          );
          return { method: 'totp' as const, backupCodesRemaining: 0 };
        }),
        replaceBackupCodes: (...args: ReplaceArgs) =>
          real.replaceBackupCodes(...args),
      };
      const { service } = build(db, racing);

      await expect(
        service.enable(
          { userId, sid },
          '123456',
          request(),
          response() as never,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'MFA_SETUP_MISSING' },
      });
      const u = await client.query<{
        totp_secret_enc: string | null;
        totp_pending_secret_enc: string | null;
        totp_enabled_at: Date | null;
      }>(
        `SELECT totp_secret_enc, totp_pending_secret_enc, totp_enabled_at
           FROM users WHERE id = $1`,
        [userId],
      );
      expect(u.rows[0]).toEqual({
        totp_secret_enc: null,
        totp_pending_secret_enc: 'pending-B',
        totp_enabled_at: null,
      });
      const codes = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM user_backup_codes WHERE user_id = $1`,
        [userId],
      );
      expect(Number(codes.rows[0].n)).toBe(0);
    });
  });

  it('enable without a race promotes the checked pending secret', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const sid = (
        await client.query<{ id: string }>(
          `INSERT INTO user_sessions (user_id, label, device_type, expires_at)
           VALUES ($1, 'Chrome on Windows', 'desktop', now() + interval '30 days')
           RETURNING id`,
          [userId],
        )
      ).rows[0].id;
      await client.query(
        `UPDATE users SET totp_pending_secret_enc = 'pending-A' WHERE id = $1`,
        [userId],
      );
      const real = new SecondFactorService(db);
      const { service } = build(db, {
        check: jest.fn(() =>
          Promise.resolve({ method: 'totp' as const, backupCodesRemaining: 0 }),
        ),
        replaceBackupCodes: (...args: ReplaceArgs) =>
          real.replaceBackupCodes(...args),
      });

      const out = await service.enable(
        { userId, sid },
        '123456',
        request(),
        response() as never,
      );

      expect(out.backupCodes).toHaveLength(10);
      const u = await client.query<{
        totp_secret_enc: string | null;
        totp_pending_secret_enc: string | null;
      }>(
        `SELECT totp_secret_enc, totp_pending_secret_enc FROM users WHERE id = $1`,
        [userId],
      );
      expect(u.rows[0]).toEqual({
        totp_secret_enc: 'pending-A',
        totp_pending_secret_enc: null,
      });
    });
  });
});
