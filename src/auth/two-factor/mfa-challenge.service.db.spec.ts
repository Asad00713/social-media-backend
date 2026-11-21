import { JwtService } from '@nestjs/jwt';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { MfaChallengeService } from './mfa-challenge.service';

const MIGRATIONS = [
  '0072_known_devices.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
];
const rand = () => Math.random().toString(36).slice(2, 10);

function build(db: DbType) {
  return new MfaChallengeService(db, new JwtService({}), {
    get: (k: string) =>
      k === 'JWT_ACCESS_SECRET' ? 'access-secret' : undefined,
  } as never);
}

async function seedUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Challenger') RETURNING id`,
    [`mfa-${rand()}@example.test`],
  );
  return r.rows[0].id;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
  return 'resolved';
};

describeDb('MfaChallengeService (database)', () => {
  it('create writes a 5-minute mfa row; open finds it', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const service = build(db);
      const token = await service.create(userId, 'd'.repeat(64));
      const opened = await service.open(token);
      const row = await client.query<{
        purpose: string;
        attempts: number;
        secs: number;
      }>(
        `SELECT purpose, attempts,
                extract(epoch FROM expires_at - now())::int AS secs
           FROM login_challenges WHERE id = $1`,
        [opened.cid],
      );
      return { opened, row: row.rows[0], userId };
    });
    expect(result.opened).toMatchObject({
      userId: result.userId,
      deviceHash: 'd'.repeat(64),
    });
    expect(result.row.purpose).toBe('mfa');
    expect(result.row.attempts).toBe(0);
    expect(result.row.secs).toBeGreaterThanOrEqual(299);
    expect(result.row.secs).toBeLessThanOrEqual(300);
  });

  it('consume succeeds once; a second consume is false; open then refuses', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const service = build(db);
      const token = await service.create(userId, null);
      const { cid } = await service.open(token);
      return {
        first: await service.consume(cid),
        second: await service.consume(cid),
        open: await codeOf(service.open(token)),
      };
    });
    expect(result).toEqual({
      first: true,
      second: false,
      open: 'MFA_CHALLENGE_EXPIRED',
    });
  });

  it('five recordFailure calls burn the challenge; open then throws MFA_CHALLENGE_EXPIRED', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const service = build(db);
      const token = await service.create(userId, null);
      const { cid } = await service.open(token);
      const left: number[] = [];
      for (let i = 0; i < 5; i++) left.push(await service.recordFailure(cid));
      return {
        left,
        sixth: await codeOf(service.recordFailure(cid)),
        open: await codeOf(service.open(token)),
        consume: await service.consume(cid),
      };
    });
    expect(result.left).toEqual([4, 3, 2, 1, 0]);
    expect(result.sixth).toBe('MFA_CHALLENGE_EXPIRED');
    expect(result.open).toBe('MFA_CHALLENGE_EXPIRED');
    expect(result.consume).toBe(false);
  });

  it('two concurrent recordFailure calls both count (no lost update)', async () => {
    // node-postgres queues both calls' statements on the one connection, so
    // a read-then-write implementation would read 0 twice and write 1: the
    // atomic `attempts = attempts + 1 ... RETURNING` must give 2.
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const service = build(db);
      const { cid } = await service.open(await service.create(userId, null));
      const lefts = await Promise.all([
        service.recordFailure(cid),
        service.recordFailure(cid),
      ]);
      const r = await client.query<{ attempts: number }>(
        `SELECT attempts FROM login_challenges WHERE id = $1`,
        [cid],
      );
      return { lefts: lefts.sort(), attempts: r.rows[0].attempts };
    });
    expect(result.attempts).toBe(2);
    expect(result.lefts).toEqual([3, 4]);
  });

  it('an expired row cannot be consumed, opened or failed against', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const service = build(db);
      const token = await service.create(userId, null);
      const { cid } = await service.open(token);
      await client.query(
        `UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [cid],
      );
      return {
        consume: await service.consume(cid),
        open: await codeOf(service.open(token)),
        fail: await codeOf(service.recordFailure(cid)),
      };
    });
    expect(result).toEqual({
      consume: false,
      open: 'MFA_CHALLENGE_EXPIRED',
      fail: 'MFA_CHALLENGE_EXPIRED',
    });
  });

  it('create prunes that user’s mfa challenges expired over a day ago, nothing else', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const other = await seedUser(client);
      const insert = (u: string, purpose: string, age: string) =>
        client
          .query<{ id: string }>(
            `INSERT INTO login_challenges (user_id, purpose, expires_at)
             VALUES ($1, $2, now() - $3::interval) RETURNING id`,
            [u, purpose, age],
          )
          .then((r) => r.rows[0].id);
      const old = await insert(userId, 'mfa', '25 hours');
      const recent = await insert(userId, 'mfa', '23 hours');
      const admin = await insert(userId, 'admin_email', '25 hours');
      const others = await insert(other, 'mfa', '25 hours');
      await build(db).create(userId, null);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM login_challenges WHERE id = ANY($1)`,
        [[old, recent, admin, others]],
      );
      return {
        left: r.rows.map((x) => x.id).sort(),
        expected: [recent, admin, others].sort(),
      };
    });
    expect(result.left).toEqual(result.expected);
  });

  it('a challenge for another user is refused by open (sub must own the row)', async () => {
    const code = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = await seedUser(client);
      const b = await seedUser(client);
      const service = build(db);
      const token = await service.create(a, null);
      const { cid } = await service.open(token);
      await client.query(
        `UPDATE login_challenges SET user_id = $1 WHERE id = $2`,
        [b, cid],
      );
      return codeOf(service.open(token));
    });
    expect(code).toBe('MFA_CHALLENGE_EXPIRED');
  });
});
