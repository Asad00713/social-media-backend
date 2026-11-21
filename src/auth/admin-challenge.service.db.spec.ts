import { JwtService } from '@nestjs/jwt';
import type { PoolClient } from 'pg';
import { hash } from '../common/utils/encryption.util';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import { AdminChallengeService } from './admin-challenge.service';

const MIGRATIONS = [
  '0024_admin_login_challenges.sql',
  // Every column a full users row names (verifyChallenge reads one).
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0073_users_email_changed_at.sql',
  '0092_user_account_settings.sql',
  '0072_known_devices.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
];
const CODE = '246810';
const rand = () => Math.random().toString(36).slice(2, 10);

function build(db: DbType) {
  return new AdminChallengeService(
    db,
    new JwtService({}),
    {
      get: (k: string) =>
        k === 'JWT_ACCESS_SECRET' ? 'access-secret' : undefined,
    } as never,
    { sendNow: jest.fn() } as never,
  );
}

/** A super admin with one live emailed challenge for CODE. */
async function seed(
  client: PoolClient,
): Promise<{ userId: string; email: string; challengeId: string }> {
  const email = `owner-${rand()}@example.test`;
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, role, is_email_verified)
     VALUES ($1, 'Owner', 'SUPER_ADMIN', true) RETURNING id`,
    [email],
  );
  const c = await client.query<{ id: string }>(
    `INSERT INTO admin_login_challenges (user_id, otp_hash, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes') RETURNING id`,
    [u.rows[0].id, hash(CODE)],
  );
  return { userId: u.rows[0].id, email, challengeId: c.rows[0].id };
}

const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const status = (e as { getStatus?: () => number }).getStatus;
    if (!status) throw e;
    return (e as { getStatus(): number }).getStatus();
  }
};

describeDb('AdminChallengeService (database)', () => {
  it('two concurrent wrong verifies both count: attempts = 2', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { email, challengeId } = await seed(client);
      const s = build(db);
      const answers = await Promise.all([
        statusOf(s.verifyChallenge(email, '000000')),
        statusOf(s.verifyChallenge(email, '111111')),
      ]);
      const row = await client.query<{ attempts: number }>(
        `SELECT attempts FROM admin_login_challenges WHERE id = $1`,
        [challengeId],
      );
      return { answers, attempts: row.rows[0].attempts };
    });
    expect(r).toEqual({ answers: [401, 401], attempts: 2 });
  });

  it('ten parallel guesses test at most five codes; a right code after them is refused', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { email, challengeId } = await seed(client);
      const s = build(db);
      const wrong = Array.from({ length: 10 }, (_, i) =>
        statusOf(s.verifyChallenge(email, String(100000 + i))),
      );
      const right = statusOf(s.verifyChallenge(email, CODE));
      const answers = await Promise.all([...wrong, right]);
      const row = await client.query<{ attempts: number }>(
        `SELECT attempts FROM admin_login_challenges WHERE id = $1`,
        [challengeId],
      );
      return { right: answers[10], attempts: row.rows[0].attempts };
    });
    expect(r.attempts).toBe(5);
    expect(r.right).toBe(401);
  });

  it('a right code yields a token whose row is consumed once; a second consume is 401', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { userId, email } = await seed(client);
      const s = build(db);
      const token = await s.verifyChallenge(email, CODE);
      const rows = await client.query<{ purpose: string; secs: number }>(
        `SELECT purpose, extract(epoch FROM expires_at - now())::int AS secs
           FROM login_challenges WHERE user_id = $1`,
        [userId],
      );
      return {
        row: rows.rows[0],
        count: rows.rowCount,
        first: await statusOf(s.consumeChallengeToken(token, userId)),
        second: await statusOf(s.consumeChallengeToken(token, userId)),
        // And the emailed code itself is spent: it cannot mint a second token.
        again: await statusOf(s.verifyChallenge(email, CODE)),
      };
    });
    expect(r.count).toBe(1);
    expect(r.row.purpose).toBe('admin_email');
    expect(r.row.secs).toBeGreaterThanOrEqual(299);
    expect(r.row.secs).toBeLessThanOrEqual(300);
    expect(r.first).toBe('ok');
    expect(r.second).toBe(401);
    expect(r.again).toBe(401);
  });

  it('an expired login_challenges row → 401', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { userId, email } = await seed(client);
      const s = build(db);
      const token = await s.verifyChallenge(email, CODE);
      await client.query(
        `UPDATE login_challenges SET expires_at = now() - interval '1 second'
          WHERE user_id = $1`,
        [userId],
      );
      return statusOf(s.consumeChallengeToken(token, userId));
    });
    expect(r).toBe(401);
  });

  it('a token is refused for another user, and an mfa row never stands in for it', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = await seed(client);
      const b = await seed(client);
      const s = build(db);
      const token = await s.verifyChallenge(a.email, CODE);
      // Re-purpose the row: an mfa challenge must not satisfy the admin step.
      await client.query(
        `UPDATE login_challenges SET purpose = 'mfa' WHERE user_id = $1`,
        [a.userId],
      );
      return {
        other: await statusOf(s.consumeChallengeToken(token, b.userId)),
        mfaRow: await statusOf(s.consumeChallengeToken(token, a.userId)),
      };
    });
    expect(r).toEqual({ other: 401, mfaRow: 401 });
  });
});
