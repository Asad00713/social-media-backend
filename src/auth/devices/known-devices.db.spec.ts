import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { KnownDevicesService } from './known-devices.service';

const MIGRATIONS = ['0072_known_devices.sql'];
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
