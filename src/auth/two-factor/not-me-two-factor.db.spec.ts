import { JwtService } from '@nestjs/jwt';
import type { PoolClient } from 'pg';
import type { AuthService } from '../auth.service';
import { AppLinks } from '../../email/links/app-links';
import { SecurityActionsService } from '../../email/public/security-actions.service';
import { EmailTokensService } from '../../email/tokens/email-tokens.service';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { AccountSecurityService } from '../../users/account-security.service';
import { SessionIssuer } from '../session/session-issuer';
import { SessionStore } from '../session/session-store';
import { SecondFactorService } from './second-factor.service';
import { TwoFactorService } from './two-factor.service';

/**
 * Final review finding 1: "This wasn't me" on the "two-step sign-in is on"
 * email turns that two-step sign-in off (an attacker with the password may
 * have set it up with their own app) - and an old link never turns off one
 * set up later.
 */

// 0070/0072: sessions_revoked_at and known_devices (revokeAll writes both).
// 0071/0073: the pending-email columns securing cancels. 0092: deleted_at,
// which the issuer reads. 0098/0099: sessions and the two-step columns.
const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0072_known_devices.sql',
  '0073_users_email_changed_at.sql',
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
const rand = () => Math.random().toString(36).slice(2, 10);

function request(): never {
  return {
    cookies: {},
    headers: { 'user-agent': UA, 'x-real-ip': '203.0.113.7' },
    ip: '10.0.0.1',
  } as never;
}

async function seedGoogleUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, google_sub, is_email_verified)
     VALUES ($1, 'Owner', $2, true) RETURNING id`,
    [`nm2fa-${rand()}@example.test`, `g-${rand()}`],
  );
  return r.rows[0].id;
}

async function newSession(client: PoolClient, userId: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, label, device_type, expires_at)
     VALUES ($1, 'Chrome on Windows', 'desktop', now() + interval '30 days')
     RETURNING id`,
    [userId],
  );
  return r.rows[0].id;
}

/** Real store, issuer, settings, tokens and security links; mail is faked. */
function build(db: DbType) {
  const config = { get: (key: string) => SECRETS[key] } as never;
  const sessions = new SessionStore(db, { forget: jest.fn() } as never);
  const issuer = new SessionIssuer(
    db,
    new JwtService({}),
    config,
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
  const real = new SecondFactorService(db);
  // The code itself is judged elsewhere (second-factor.service.db.spec.ts).
  const secondFactor = {
    check: jest.fn(() =>
      Promise.resolve({ method: 'totp' as const, backupCodesRemaining: 0 }),
    ),
    replaceBackupCodes: (
      ...args: Parameters<SecondFactorService['replaceBackupCodes']>
    ) => real.replaceBackupCodes(...args),
  };
  const notices = {
    enabled: jest.fn().mockResolvedValue(undefined),
    disabled: jest.fn().mockResolvedValue(undefined),
  };
  const twoFactor = new TwoFactorService(
    db,
    secondFactor as unknown as SecondFactorService,
    sessions,
    issuer,
    notices as never,
  );
  const tokens = new EmailTokensService(new JwtService({}), config);
  const links = new AppLinks({ get: () => undefined } as never);
  const none = null as never;
  const security = new AccountSecurityService(
    db,
    none,
    none,
    none,
    links,
    none,
    none,
    sessions,
  );
  const auth = { issuePasswordReset: jest.fn().mockResolvedValue(true) };
  const actions = new SecurityActionsService(
    db,
    tokens,
    security,
    auth as unknown as AuthService,
    links,
    real,
  );

  /** Setup + enable from session `sid`; returns the enabledAt its email carries. */
  const enable = async (client: PoolClient, userId: string, sid: string) => {
    await client.query(
      `UPDATE users SET totp_pending_secret_enc = $2 WHERE id = $1`,
      [userId, `pending-${rand()}`],
    );
    notices.enabled.mockClear();
    await twoFactor.enable({ userId, sid }, '123456', request(), {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    } as never);
    return (notices.enabled.mock.calls[0] as unknown[])[2] as Date;
  };
  /** The "This wasn't me" link the "two-step sign-in is on" email carries. */
  const linkFor = (userId: string, enabledAt: Date) =>
    tokens.securityToken({
      uid: userId,
      act: 'not_me_2fa',
      enabledAt: enabledAt.getTime(),
    });
  return { actions, enable, linkFor, real, auth };
}

async function stateOf(client: PoolClient, userId: string) {
  const r = await client.query<{
    enabled_at: Date | null;
    secret: string | null;
    pending: string | null;
    codes: string;
    mfa: string;
    trusted: string;
    live: string;
  }>(
    `SELECT u.totp_enabled_at AS enabled_at,
            u.totp_secret_enc AS secret,
            u.totp_pending_secret_enc AS pending,
            (SELECT count(*) FROM user_backup_codes WHERE user_id = u.id) AS codes,
            (SELECT count(*) FROM login_challenges WHERE user_id = u.id AND purpose = 'mfa') AS mfa,
            (SELECT count(*) FROM known_devices WHERE user_id = u.id AND mfa_trusted_until > now()) AS trusted,
            (SELECT count(*) FROM user_sessions WHERE user_id = u.id AND revoked_at IS NULL) AS live
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return r.rows[0];
}

/** What an attacker's 2FA leaves behind: a trusted browser and an open challenge. */
async function addTrustAndChallenge(client: PoolClient, userId: string) {
  await client.query(
    `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
     VALUES ($1, $2, 'Chrome on Linux', now() + interval '30 days')`,
    [userId, 'a'.repeat(64)],
  );
  await client.query(
    `INSERT INTO login_challenges (user_id, purpose, expires_at)
     VALUES ($1, 'mfa', now() + interval '5 minutes')`,
    [userId],
  );
}

describeDb('"This wasn\'t me" on the two-step-enabled email (database)', () => {
  it('enable → not_me_2fa → two-step sign-in is off: secret, pending, codes, challenges and trust gone; signed out; reset sent', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const { actions, enable, linkFor, auth } = build(db);
      // The attacker's session turns it on with their own app.
      const enabledAt = await enable(
        client,
        userId,
        await newSession(client, userId),
      );
      await addTrustAndChallenge(client, userId);
      // A setup restarted since (a pending secret) goes too.
      await client.query(
        `UPDATE users SET totp_pending_secret_enc = 'pending-later' WHERE id = $1`,
        [userId],
      );
      const before = await stateOf(client, userId);
      expect(before.enabled_at).not.toBeNull();
      expect(before.codes).toBe('10');

      const link = linkFor(userId, enabledAt);
      // The GET only asks, and says what will happen.
      const ask = await actions.describe(link);
      expect(ask?.body).toMatch(/turn off the two-step sign-in/);
      expect((await stateOf(client, userId)).enabled_at).not.toBeNull();

      const done = await actions.perform(link);
      expect(done?.body).toMatch(/^We turned off two-step sign-in/);
      expect(await stateOf(client, userId)).toEqual({
        enabled_at: null,
        secret: null,
        pending: null,
        codes: '0',
        mfa: '0',
        trusted: '0',
        live: '0',
      });
      expect(auth.issuePasswordReset).toHaveBeenCalledTimes(1);
    });
  });

  it('an old link after a later re-enable does nothing to the new two-step sign-in (it still secures)', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const { actions, enable, linkFor, real, auth } = build(db);
      const sid = await newSession(client, userId);
      const first = await enable(client, userId, sid);
      const oldLink = linkFor(userId, first);
      // The owner turns it off and on again with their own app.
      await real.clear(userId);
      const second = await enable(client, userId, sid);
      expect(second.getTime()).not.toBe(first.getTime());
      await addTrustAndChallenge(client, userId);

      const ask = await actions.describe(oldLink);
      expect(ask?.body).not.toMatch(/two-step/);
      const done = await actions.perform(oldLink);
      expect(done?.body).not.toMatch(/two-step/);

      const after = await stateOf(client, userId);
      // Two-step sign-in untouched: the second enable, its codes and its
      // open challenge. Securing still signed out and cleared trust (as
      // the plain not_me does).
      expect(after.enabled_at?.getTime()).toBe(second.getTime());
      expect(after.secret).not.toBeNull();
      expect(after.codes).toBe('10');
      expect(after.mfa).toBe('1');
      expect(after.trusted).toBe('0');
      expect(after.live).toBe('0');
      expect(auth.issuePasswordReset).toHaveBeenCalledTimes(1);
    });
  });

  it('the match is to the millisecond: a column with microseconds still matches its own link, one ms off does not', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedGoogleUser(client);
      const { real } = build(db);
      await client.query(
        `UPDATE users SET totp_secret_enc = 's', totp_enabled_at = '2026-11-21T09:30:15.123456Z'
          WHERE id = $1`,
        [userId],
      );
      const at = Date.UTC(2026, 10, 21, 9, 30, 15, 123);
      const off = await real.clearIfEnabledAt(userId, new Date(at + 1));
      const offState = (await stateOf(client, userId)).enabled_at;
      const exact = await real.clearIfEnabledAt(userId, new Date(at));
      expect({
        off,
        offKept: offState !== null,
        exact,
        after: (await stateOf(client, userId)).enabled_at,
      }).toEqual({ off: false, offKept: true, exact: true, after: null });
    });
  });
});
