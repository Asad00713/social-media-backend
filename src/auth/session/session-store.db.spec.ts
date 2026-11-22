import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { SessionStore, SESSION_IDLE_DAYS } from './session-store';

const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0072_known_devices.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const rand = () => Math.random().toString(36).slice(2, 10);

function build(db: DbType) {
  const check = { forget: jest.fn<void, [string]>() };
  const store = new SessionStore(db, check as never);
  return { store, check };
}

async function seedUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Session Owner') RETURNING id`,
    [`sessions-${rand()}@example.test`],
  );
  return r.rows[0].id;
}

function input(userId: string) {
  return {
    userId,
    deviceHash: 'd'.repeat(64),
    label: 'Chrome on Windows',
    deviceType: 'desktop' as const,
    ip: '203.0.113.7',
  };
}

async function rowOf(client: PoolClient, sid: string) {
  const r = await client.query<{
    revoked_at: Date | null;
    expires_at: Date;
    last_used_at: Date;
    now: Date;
  }>(
    `SELECT revoked_at, expires_at, last_used_at, now() AS now
       FROM user_sessions WHERE id = $1`,
    [sid],
  );
  return r.rows[0];
}

describeDb('SessionStore (database)', () => {
  it('pins the idle window at 30 days', () => {
    expect(SESSION_IDLE_DAYS).toBe(30);
  });

  it('create sets expires_at to about now + 30 days and stores the fields', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const created = await store.create(input(userId));
      const r = await client.query<{
        user_id: string;
        device_hash: string;
        label: string;
        device_type: string;
        ip: string;
        expires_at: Date;
        now: Date;
      }>(
        `SELECT user_id, device_hash, label, device_type, ip, expires_at, now() AS now
           FROM user_sessions WHERE id = $1`,
        [created.id],
      );
      return { created, row: r.rows[0], userId };
    });

    const { created, row, userId } = result;
    expect(row.user_id).toBe(userId);
    expect(row.device_hash).toBe('d'.repeat(64));
    expect(row.label).toBe('Chrome on Windows');
    expect(row.device_type).toBe('desktop');
    expect(row.ip).toBe('203.0.113.7');
    const expected = row.now.getTime() + 30 * DAY_MS;
    expect(Math.abs(row.expires_at.getTime() - expected)).toBeLessThan(1000);
    expect(created.expiresAt.getTime()).toBe(row.expires_at.getTime());
  });

  it("create clears that user's sessions revoked or expired more than 90 days ago", async () => {
    const left = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const otherUser = await seedUser(client);
      const { store } = build(db);
      const old = await store.create(input(userId));
      const oldExpired = await store.create(input(userId));
      const recent = await store.create(input(userId));
      const othersOld = await store.create(input(otherUser));
      await client.query(
        `UPDATE user_sessions SET revoked_at = now() - interval '91 days' WHERE id = ANY($1)`,
        [[old.id, othersOld.id]],
      );
      await client.query(
        `UPDATE user_sessions SET expires_at = now() - interval '91 days' WHERE id = $1`,
        [oldExpired.id],
      );
      await client.query(
        `UPDATE user_sessions SET revoked_at = now() - interval '89 days' WHERE id = $1`,
        [recent.id],
      );
      await store.create(input(userId));
      const r = await client.query<{ id: string }>(
        `SELECT id FROM user_sessions WHERE id = ANY($1)`,
        [[old.id, oldExpired.id, recent.id, othersOld.id]],
      );
      return {
        ids: r.rows.map((x) => x.id).sort(),
        recent: recent.id,
        othersOld: othersOld.id,
      };
    });
    expect(left.ids).toEqual([left.recent, left.othersOld].sort());
  });

  it('touch extends a live row and refuses a revoked or idle-expired one', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const live = await store.create(input(userId));
      const revoked = await store.create(input(userId));
      const idle = await store.create(input(userId));
      await client.query(
        `UPDATE user_sessions SET expires_at = now() + interval '1 day',
                last_used_at = now() - interval '29 days' WHERE id = $1`,
        [live.id],
      );
      await client.query(
        `UPDATE user_sessions SET revoked_at = now() WHERE id = $1`,
        [revoked.id],
      );
      await client.query(
        `UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [idle.id],
      );
      return {
        live: await store.touch(live.id, userId),
        liveRow: await rowOf(client, live.id),
        revoked: await store.touch(revoked.id, userId),
        idle: await store.touch(idle.id, userId),
        idleRow: await rowOf(client, idle.id),
        garbage: await store.touch('not-a-uuid', userId),
      };
    });

    expect(result.live).toBe(true);
    const expected = result.liveRow.now.getTime() + 30 * DAY_MS;
    expect(
      Math.abs(result.liveRow.expires_at.getTime() - expected),
    ).toBeLessThan(1000);
    expect(result.liveRow.last_used_at.getTime()).toBe(
      result.liveRow.now.getTime(),
    );
    expect(result.revoked).toBe(false);
    expect(result.idle).toBe(false);
    // A refused touch leaves the expired row expired.
    expect(result.idleRow.expires_at.getTime()).toBeLessThan(
      result.idleRow.now.getTime(),
    );
    expect(result.garbage).toBe(false);
  });

  it('isLive and createdAt see live rows only', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const live = await store.create(input(userId));
      const revoked = await store.create(input(userId));
      await store.revoke(userId, revoked.id);
      return {
        live: await store.isLive(live.id, userId),
        revoked: await store.isLive(revoked.id, userId),
        wrongUser: await store.isLive(live.id, await seedUser(client)),
        createdLive: await store.createdAt(live.id, userId),
        createdRevoked: await store.createdAt(revoked.id, userId),
      };
    });
    expect(result.live).toBe(true);
    expect(result.revoked).toBe(false);
    expect(result.wrongUser).toBe(false);
    expect(result.createdLive).toBeInstanceOf(Date);
    expect(result.createdRevoked).toBeNull();
  });

  it('revokeOthers keeps keepSid, revokes the rest, moves the floor, clears trust', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const bystander = await seedUser(client);
      const { store, check } = build(db);
      const keep = await store.create(input(userId));
      const a = await store.create(input(userId));
      const b = await store.create(input(userId));
      const theirs = await store.create(input(bystander));
      for (const u of [userId, bystander]) {
        await client.query(
          `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
           VALUES ($1, $2, 'Chrome on Windows', now() + interval '30 days')`,
          [u, 'e'.repeat(64)],
        );
      }
      const revoked = await store.revokeOthers(userId, keep.id);
      const users = await client.query<{
        id: string;
        sessions_revoked_at: Date | null;
      }>(`SELECT id, sessions_revoked_at FROM users WHERE id = ANY($1)`, [
        [userId, bystander],
      ]);
      const trust = await client.query<{
        user_id: string;
        mfa_trusted_until: Date | null;
      }>(
        `SELECT user_id, mfa_trusted_until FROM known_devices WHERE user_id = ANY($1)`,
        [[userId, bystander]],
      );
      return {
        revoked,
        keep: await rowOf(client, keep.id),
        a: await rowOf(client, a.id),
        b: await rowOf(client, b.id),
        theirs: await rowOf(client, theirs.id),
        floor: Object.fromEntries(
          users.rows.map((r) => [r.id, r.sessions_revoked_at]),
        ),
        trust: Object.fromEntries(
          trust.rows.map((r) => [r.user_id, r.mfa_trusted_until]),
        ),
        ids: { userId, bystander, a: a.id, b: b.id },
        forgotten: check.forget.mock.calls.map((c) => c[0]).sort(),
      };
    });

    expect(result.revoked).toBe(2);
    expect(result.keep.revoked_at).toBeNull();
    expect(result.a.revoked_at).not.toBeNull();
    expect(result.b.revoked_at).not.toBeNull();
    expect(result.theirs.revoked_at).toBeNull();
    expect(result.floor[result.ids.userId]).toBeInstanceOf(Date);
    expect(result.floor[result.ids.bystander]).toBeNull();
    expect(result.trust[result.ids.userId]).toBeNull();
    expect(result.trust[result.ids.bystander]).toBeInstanceOf(Date);
    expect(result.forgotten).toEqual([result.ids.a, result.ids.b].sort());
  });

  it('revokeOthers with no keepSid revokes every row', async () => {
    const revoked = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      await store.create(input(userId));
      await store.create(input(userId));
      return store.revokeOthers(userId, null);
    });
    expect(revoked).toBe(2);
  });

  it('revokeAll revokes every row, moves the floor and clears trust', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store, check } = build(db);
      const a = await store.create(input(userId));
      const b = await store.create(input(userId));
      const already = await store.create(input(userId));
      await store.revoke(userId, already.id);
      check.forget.mockClear();
      await client.query(
        `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
         VALUES ($1, $2, 'Chrome on Windows', now() + interval '30 days')`,
        [userId, 'e'.repeat(64)],
      );
      const n = await store.revokeAll(userId);
      const floor = await client.query<{ sessions_revoked_at: Date | null }>(
        `SELECT sessions_revoked_at FROM users WHERE id = $1`,
        [userId],
      );
      const trust = await client.query<{ mfa_trusted_until: Date | null }>(
        `SELECT mfa_trusted_until FROM known_devices WHERE user_id = $1`,
        [userId],
      );
      return {
        n,
        live: await store.listLive(userId),
        floor: floor.rows[0].sessions_revoked_at,
        trust: trust.rows[0].mfa_trusted_until,
        forgotten: check.forget.mock.calls.map((c) => c[0]).sort(),
        ids: [a.id, b.id].sort(),
      };
    });
    expect(result.n).toBe(2);
    expect(result.live).toEqual([]);
    expect(result.floor).toBeInstanceOf(Date);
    expect(result.trust).toBeNull();
    expect(result.forgotten).toEqual(result.ids);
  });

  it("clearTrust clears that user's trusted devices only, and revokes nothing", async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const bystander = await seedUser(client);
      const { store } = build(db);
      const live = await store.create(input(userId));
      for (const u of [userId, bystander]) {
        await client.query(
          `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
           VALUES ($1, $2, 'Chrome on Windows', now() + interval '30 days')`,
          [u, 'f'.repeat(64)],
        );
      }
      await store.clearTrust(userId);
      const trust = await client.query<{
        user_id: string;
        mfa_trusted_until: Date | null;
      }>(
        `SELECT user_id, mfa_trusted_until FROM known_devices WHERE user_id = ANY($1)`,
        [[userId, bystander]],
      );
      const floor = await client.query<{ at: Date | null }>(
        `SELECT sessions_revoked_at AS at FROM users WHERE id = $1`,
        [userId],
      );
      return {
        trust: Object.fromEntries(
          trust.rows.map((r) => [r.user_id, r.mfa_trusted_until]),
        ),
        ids: { userId, bystander },
        stillLive: await store.isLive(live.id, userId),
        floor: floor.rows[0].at,
      };
    });
    expect(result.trust[result.ids.userId]).toBeNull();
    expect(result.trust[result.ids.bystander]).not.toBeNull();
    expect(result.stillLive).toBe(true);
    expect(result.floor).toBeNull();
  });

  it("revoke clears the trust of that session's browser only: not the user's other browsers, not another user's (finding 2)", async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const bystander = await seedUser(client);
      const { store, check } = build(db);
      const trust = (u: string, hash: string) =>
        client.query(
          `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
           VALUES ($1, $2, 'Chrome on Linux', now() + interval '30 days')`,
          [u, hash],
        );
      const attacker = await store.create({
        ...input(userId),
        deviceHash: 'a'.repeat(64),
      });
      await store.create({ ...input(userId), deviceHash: 'b'.repeat(64) });
      const noDevice = await store.create({
        ...input(userId),
        deviceHash: null,
      });
      await trust(userId, 'a'.repeat(64));
      await trust(userId, 'b'.repeat(64));
      // Another account signed in on the same browser keeps its own trust.
      await trust(bystander, 'a'.repeat(64));

      const revoked = await store.revoke(userId, attacker.id);
      const again = await store.revoke(userId, noDevice.id);
      const rows = await client.query<{
        user_id: string;
        device_hash: string;
        trusted: boolean;
      }>(
        `SELECT user_id, device_hash, mfa_trusted_until IS NOT NULL AS trusted
           FROM known_devices WHERE user_id = ANY($1)`,
        [[userId, bystander]],
      );
      const t = (u: string, h: string) =>
        rows.rows.find((r) => r.user_id === u && r.device_hash === h)?.trusted;
      return {
        revoked,
        again,
        row: await rowOf(client, attacker.id),
        attackerTrusted: t(userId, 'a'.repeat(64)),
        ownerOtherTrusted: t(userId, 'b'.repeat(64)),
        bystanderTrusted: t(bystander, 'a'.repeat(64)),
        forgotten: check.forget.mock.calls.map((c) => c[0]),
        ids: [attacker.id, noDevice.id],
      };
    });
    expect(result.revoked).toBe(true);
    expect(result.again).toBe(true);
    expect(result.row.revoked_at).not.toBeNull();
    expect(result.attackerTrusted).toBe(false);
    expect(result.ownerOtherTrusted).toBe(true);
    expect(result.bystanderTrusted).toBe(true);
    expect(result.forgotten).toEqual(result.ids);
  });

  it('revoke of a session that is not live clears no trust', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const s = await store.create({
        ...input(userId),
        deviceHash: 'a'.repeat(64),
      });
      await client.query(
        `UPDATE user_sessions SET revoked_at = now() - interval '1 day' WHERE id = $1`,
        [s.id],
      );
      // Trusted again since (a later sign-in on that browser passed the code).
      await client.query(
        `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
         VALUES ($1, $2, 'Chrome on Linux', now() + interval '30 days')`,
        [userId, 'a'.repeat(64)],
      );
      const revoked = await store.revoke(userId, s.id);
      const r = await client.query<{ trusted: boolean }>(
        `SELECT mfa_trusted_until IS NOT NULL AS trusted FROM known_devices WHERE user_id = $1`,
        [userId],
      );
      return { revoked, trusted: r.rows[0].trusted };
    });
    expect(result).toEqual({ revoked: false, trusted: true });
  });

  it('revoke rolls back with a caller transaction, trust clear included', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const s = await store.create({
        ...input(userId),
        deviceHash: 'a'.repeat(64),
      });
      await client.query(
        `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
         VALUES ($1, $2, 'Chrome on Linux', now() + interval '30 days')`,
        [userId, 'a'.repeat(64)],
      );
      await db
        .transaction(async (tx) => {
          await store.revoke(userId, s.id, tx);
          throw new Error('roll back');
        })
        .catch(() => undefined);
      const r = await client.query<{ trusted: boolean }>(
        `SELECT mfa_trusted_until IS NOT NULL AS trusted FROM known_devices WHERE user_id = $1`,
        [userId],
      );
      return {
        revokedAt: (await rowOf(client, s.id)).revoked_at,
        trusted: r.rows[0].trusted,
      };
    });
    expect(result).toEqual({ revokedAt: null, trusted: true });
  });

  it('revoke and revokeOthers run on a caller transaction (executor)', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const a = await store.create(input(userId));
      // A nested transaction on the harness db is a savepoint; rolling it
      // back must take the revoke with it.
      await db
        .transaction(async (tx) => {
          await store.revokeOthers(userId, null, tx);
          throw new Error('roll back');
        })
        .catch(() => undefined);
      const afterRollback = await rowOf(client, a.id);
      return { revokedAt: afterRollback.revoked_at };
    });
    expect(result.revokedAt).toBeNull();
  });

  it('listLive excludes revoked and expired rows, newest use first', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const older = await store.create(input(userId));
      const newer = await store.create(input(userId));
      const revoked = await store.create(input(userId));
      const expired = await store.create(input(userId));
      await client.query(
        `UPDATE user_sessions SET last_used_at = now() - interval '2 hours' WHERE id = $1`,
        [older.id],
      );
      await client.query(
        `UPDATE user_sessions SET last_used_at = now() - interval '1 hour' WHERE id = $1`,
        [newer.id],
      );
      await store.revoke(userId, revoked.id);
      await client.query(
        `UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired.id],
      );
      const live = await store.listLive(userId);
      return { ids: live.map((s) => s.id), expected: [newer.id, older.id] };
    });
    expect(result.ids).toEqual(result.expected);
  });

  it("touch/revoke ignore another user's sid", async () => {
    const result = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const owner = await seedUser(client);
      const intruder = await seedUser(client);
      const { store, check } = build(db);
      const s = await store.create(input(owner));
      const revoke = await store.revoke(intruder, s.id);
      const touch = await store.touch(s.id, intruder);
      const others = await store.revokeOthers(intruder, null);
      return {
        revoke,
        touch,
        others,
        row: await rowOf(client, s.id),
        forgotten: check.forget.mock.calls.length,
        ownerRevoke: await store.revoke(owner, s.id),
        ownerRevokeAgain: await store.revoke(owner, s.id),
      };
    });
    expect(result.revoke).toBe(false);
    expect(result.touch).toBe(false);
    expect(result.others).toBe(0);
    expect(result.row.revoked_at).toBeNull();
    expect(result.forgotten).toBe(0);
    expect(result.ownerRevoke).toBe(true);
    expect(result.ownerRevokeAgain).toBe(false);
  });

  it('setCountry writes the country onto the row', async () => {
    const country = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { store } = build(db);
      const s = await store.create(input(userId));
      await store.setCountry(s.id, 'Pakistan');
      const r = await client.query<{ country: string | null }>(
        `SELECT country FROM user_sessions WHERE id = $1`,
        [s.id],
      );
      return r.rows[0].country;
    });
    expect(country).toBe('Pakistan');
  });
});
