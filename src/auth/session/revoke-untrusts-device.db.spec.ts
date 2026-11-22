import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { DEVICE_COOKIE } from '../devices/device-cookie';
import { KnownDevicesService } from '../devices/known-devices.service';
import { SessionIssuer } from './session-issuer';
import { SessionStore } from './session-store';

/**
 * Final review finding 2: an attacker who passed TOTP once on their browser
 * is trusted there for 30 days. The owner revokes that one session (or it
 * logs out); the password alone must not sign that browser straight back in.
 */

// 0070/0072: sessions_revoked_at and known_devices. 0092: users.deleted_at,
// which the issuer reads. 0098/0099: sessions and the two-step columns.
const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0072_known_devices.sql',
  '0092_user_account_settings.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
];
const SECRETS: Record<string, string> = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const rand = () => Math.random().toString(36).slice(2, 10);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

async function seedTwoStepUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, totp_secret_enc, totp_enabled_at)
     VALUES ($1, 'Owner', 'enc', now()) RETURNING id`,
    [`untrust-${rand()}@example.test`],
  );
  return r.rows[0].id;
}

function request(deviceId: string): never {
  return {
    cookies: { [DEVICE_COOKIE]: deviceId },
    headers: { 'user-agent': UA, 'x-real-ip': '203.0.113.7' },
    ip: '10.0.0.1',
  } as never;
}

function build(db: DbType) {
  const sessions = new SessionStore(db, { forget: jest.fn() } as never);
  // The real trust lookup; the sighting and its email are not under test.
  const none = null as never;
  const real = new KnownDevicesService(db, none, none, none, none, none, none);
  const knownDevices = {
    isMfaTrusted: (userId: string, deviceId: string) =>
      real.isMfaTrusted(userId, deviceId),
    track: jest.fn(),
    markMfaTrusted: jest.fn(),
  };
  const challenges = { create: jest.fn().mockResolvedValue('challenge') };
  const issuer = new SessionIssuer(
    db,
    new JwtService({}),
    { get: (key: string) => SECRETS[key] } as never,
    sessions,
    knownDevices as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { lookup: jest.fn().mockResolvedValue(null) } as never,
    challenges as never,
  );
  const login = (userId: string, deviceId: string) =>
    issuer.issue(
      userId,
      request(deviceId),
      { cookie: jest.fn(), clearCookie: jest.fn() } as never,
      { via: 'password' },
    );
  return { sessions, login };
}

describeDb('revoking a session untrusts its browser (database)', () => {
  it('trusted browser + revoke its session → the next password sign-in there is challenged', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedTwoStepUser(client);
      const { sessions, login } = build(db);
      const attackerDevice = randomBytes(32).toString('base64url');
      const ownerDevice = randomBytes(32).toString('base64url');
      for (const device of [attackerDevice, ownerDevice]) {
        await client.query(
          `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
           VALUES ($1, $2, 'Chrome on Linux', now() + interval '30 days')`,
          [userId, sha256(device)],
        );
      }

      // Trusted: the password alone makes a session on that browser.
      const first = await login(userId, attackerDevice);
      expect(first.kind).toBe('session');

      // The owner revokes it in Settings -> Sessions.
      expect(
        await sessions.revoke(userId, (first as { sid: string }).sid),
      ).toBe(true);

      // Same browser, same password: now it must pass the second factor.
      expect(await login(userId, attackerDevice)).toEqual({
        kind: 'mfa',
        challengeToken: 'challenge',
      });
      // The owner's own trusted browser is left alone.
      expect((await login(userId, ownerDevice)).kind).toBe('session');
    });
  });
});
