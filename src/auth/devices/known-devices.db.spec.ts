import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { KnownDevicesService } from './known-devices.service';

// 0099 adds known_devices.mfa_trusted_until, which every insert now names.
const MIGRATIONS = ['0072_known_devices.sql', '0099_two_factor.sql'];
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CTX = { ip: '39.48.12.201', userAgent: CHROME_WINDOWS };

const rand = () => Math.random().toString(36).slice(2, 10);
const deviceId = (c: string) => c.repeat(43);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function build(db: DbType) {
  const notify = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new KnownDevicesService(
    db,
    {
      lookup: jest
        .fn()
        .mockResolvedValue({ country: 'Pakistan', countryCode: 'PK' }),
    } as never,
    notify as never,
    { userTimezone: jest.fn().mockResolvedValue('UTC') } as never,
    { newLogin: jest.fn() } as never,
    { securityToken: jest.fn().mockReturnValue('tok') } as never,
    { api: (p: string) => `https://api.test${p}` } as never,
  );
  return { service, notify };
}

async function seedUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Device Owner') RETURNING id`,
    [`devices-${rand()}@example.test`],
  );
  return r.rows[0].id;
}

async function rowsFor(client: PoolClient, userId: string) {
  const r = await client.query<{
    device_hash: string;
    label: string;
    country: string | null;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT device_hash, label, country, first_seen_at, last_seen_at
       FROM known_devices WHERE user_id = $1 ORDER BY first_seen_at`,
    [userId],
  );
  return r.rows;
}

describeDb('KnownDevicesService (database)', () => {
  it('records the first device silently, then alerts once for a second one', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { service, notify } = build(db);

      await expect(service.seen(userId, deviceId('a'), CTX)).resolves.toBe(
        'first',
      );
      await expect(service.seen(userId, deviceId('a'), CTX)).resolves.toBe(
        'known',
      );
      await expect(service.seen(userId, deviceId('b'), CTX)).resolves.toBe(
        'new',
      );

      const rows = await rowsFor(client, userId);
      expect(rows.map((r) => r.device_hash).sort()).toEqual(
        [sha256(deviceId('a')), sha256(deviceId('b'))].sort(),
      );
      expect(rows[0]).toEqual(
        expect.objectContaining({
          label: 'Chrome on Windows',
          country: 'Pakistan',
        }),
      );
      expect(notify.notify).toHaveBeenCalledTimes(1);
    });
  });

  it('a known device moves last_seen_at only', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const hash = sha256(deviceId('c'));
      await client.query(
        `INSERT INTO known_devices
           (user_id, device_hash, label, country, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'Old label', 'Old country',
                 now() - interval '30 days', now() - interval '30 days')`,
        [userId, hash],
      );
      const { service } = build(db);

      await expect(service.seen(userId, deviceId('c'), CTX)).resolves.toBe(
        'known',
      );

      const [row] = await rowsFor(client, userId);
      expect(row.label).toBe('Old label');
      expect(row.country).toBe('Old country');
      expect(row.last_seen_at.getTime()).toBeGreaterThan(
        row.first_seen_at.getTime(),
      );
    });
  });

  it('concurrent two seen() for the same new device insert one row and send one email', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { service, notify } = build(db);
      await service.seen(userId, deviceId('d'), CTX);

      const results = await Promise.all([
        service.seen(userId, deviceId('e'), CTX),
        service.seen(userId, deviceId('e'), CTX),
      ]);

      expect(results.sort()).toEqual(['known', 'new']);
      const rows = await rowsFor(client, userId);
      expect(
        rows.filter((r) => r.device_hash === sha256(deviceId('e'))),
      ).toHaveLength(1);
      expect(notify.notify).toHaveBeenCalledTimes(1);
    });
  });

  it('deleting the user deletes their devices', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const { service } = build(db);
      await service.seen(userId, deviceId('f'), CTX, { silent: true });
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      expect(await rowsFor(client, userId)).toHaveLength(0);
    });
  });
});

describeDb('KnownDevicesService two-step trust (database)', () => {
  const TRUST_MIGRATIONS = [
    '0072_known_devices.sql',
    '0098_user_sessions.sql',
    '0099_two_factor.sql',
    '0100_mfa_lock_escalation.sql',
  ];
  const flush = () => new Promise((r) => setTimeout(r, 20));
  /** Waits for the detached sighting to settle (it does a few queries). */
  const settle = async () => {
    for (let i = 0; i < 25; i++) await flush();
  };
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function trustOf(client: PoolClient, userId: string, id: string) {
    const r = await client.query<{
      mfa_trusted_until: Date | null;
      label: string;
      now: Date;
    }>(
      `SELECT mfa_trusted_until, label, now() AS now FROM known_devices
        WHERE user_id = $1 AND device_hash = $2`,
      [userId, sha256(id)],
    );
    return r.rows[0];
  }

  it('markMfaTrusted on a new device inserts with mfa_trusted_until ≈ now+30d and alerts when another device exists', async () => {
    const result = await withRollbackDb(
      TRUST_MIGRATIONS,
      async (db, client) => {
        const userId = await seedUser(client);
        const { service, notify } = build(db);
        await service.seen(userId, deviceId('a'), CTX); // first device, silent
        notify.notify.mockClear();
        await service.markMfaTrusted(userId, deviceId('b'), CTX);
        const row = await trustOf(client, userId, deviceId('b'));
        // The alert is detached: it may land after the answer.
        await settle();
        const alerts = notify.notify.mock.calls.length;
        // The same device again is an update, not a second alert.
        await service.markMfaTrusted(userId, deviceId('b'), CTX);
        await settle();
        return {
          row,
          alerts,
          alertsAfterRepeat: notify.notify.mock.calls.length,
          trusted: await service.isMfaTrusted(userId, deviceId('b')),
          otherTrusted: await service.isMfaTrusted(userId, deviceId('a')),
        };
      },
    );
    const expected = result.row.now.getTime() + 30 * DAY_MS;
    expect(
      Math.abs(result.row.mfa_trusted_until!.getTime() - expected),
    ).toBeLessThan(1000);
    expect(result.row.label).toBe('Chrome on Windows');
    expect(result.alerts).toBe(1);
    expect(result.alertsAfterRepeat).toBe(1);
    expect(result.trusted).toBe(true);
    expect(result.otherTrusted).toBe(false);
  });

  it('markMfaTrusted on a person’s very first device sends no alert', async () => {
    const alerts = await withRollbackDb(
      TRUST_MIGRATIONS,
      async (db, client) => {
        const userId = await seedUser(client);
        const { service, notify } = build(db);
        await service.markMfaTrusted(userId, deviceId('a'), CTX);
        await settle();
        return notify.notify.mock.calls.length;
      },
    );
    expect(alerts).toBe(0);
  });

  it('markMfaTrusted on a known device moves trust and sends nothing (B4: it is the sighting)', async () => {
    const result = await withRollbackDb(
      TRUST_MIGRATIONS,
      async (db, client) => {
        const userId = await seedUser(client);
        const { service, notify } = build(db);
        await service.seen(userId, deviceId('a'), CTX);
        await service.seen(userId, deviceId('b'), CTX);
        notify.notify.mockClear();
        await service.markMfaTrusted(userId, deviceId('b'), CTX);
        await settle();
        return {
          alerts: notify.notify.mock.calls.length,
          trusted: await service.isMfaTrusted(userId, deviceId('b')),
        };
      },
    );
    expect(result).toEqual({ alerts: 0, trusted: true });
  });

  it('isMfaTrusted is false after mfa_trusted_until passes', async () => {
    const result = await withRollbackDb(
      TRUST_MIGRATIONS,
      async (db, client) => {
        const userId = await seedUser(client);
        const { service } = build(db);
        await service.markMfaTrusted(userId, deviceId('a'), CTX);
        const before = await service.isMfaTrusted(userId, deviceId('a'));
        await client.query(
          `UPDATE known_devices SET mfa_trusted_until = now() - interval '1 second'
          WHERE user_id = $1`,
          [userId],
        );
        return {
          before,
          after: await service.isMfaTrusted(userId, deviceId('a')),
          unknown: await service.isMfaTrusted(userId, deviceId('z')),
        };
      },
    );
    expect(result).toEqual({ before: true, after: false, unknown: false });
  });
});
