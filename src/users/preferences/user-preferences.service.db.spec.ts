import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { DEFAULT_PREFERENCES } from './user-preferences';
import { UserPreferencesService } from './user-preferences.service';

// 0088 adds users.preferences.
const MIGRATIONS = ['0088_user_account_settings.sql'];

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Prefs') RETURNING id`,
    [`prefs-${rand()}@example.test`],
  );
  return r.rows[0].id;
}

async function stored(client: PoolClient, id: string): Promise<unknown> {
  const r = await client.query<{ preferences: unknown }>(
    `SELECT preferences FROM users WHERE id = $1`,
    [id],
  );
  return r.rows[0].preferences;
}

function run<T>(
  fn: (service: UserPreferencesService, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db: DbType, client) =>
    fn(new UserPreferencesService(db), client),
  );
}

describeDb('UserPreferencesService (database)', () => {
  it('a new user reads as the defaults and stores {}', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);
      expect(await service.get(id)).toEqual(DEFAULT_PREFERENCES);
      expect(await stored(client, id)).toEqual({});
    });
  });

  it('stores sparsely and merges patches in SQL', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);

      await service.update(id, { theme: 'dark' });
      const full = await service.update(id, { timeFormat: '24h' });

      expect(await stored(client, id)).toEqual({
        theme: 'dark',
        timeFormat: '24h',
      });
      expect(full).toEqual({
        ...DEFAULT_PREFERENCES,
        theme: 'dark',
        timeFormat: '24h',
      });
      expect(await service.get(id)).toEqual(full);
    });
  });

  // The harness shares one connection, so these two statements are queued, not
  // truly parallel; the guarantee under test is that each UPDATE merges in SQL
  // (`preferences || patch`) instead of overwriting from a stale read.
  it('two patches of different keys both survive', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);
      await Promise.all([
        service.update(id, { theme: 'light' }),
        service.update(id, { weekStart: 'sunday' }),
      ]);
      expect(await stored(client, id)).toEqual({
        theme: 'light',
        weekStart: 'sunday',
      });
    });
  });

  it('timezone null is stored as an explicit null and read back as null', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);
      await service.update(id, { timezone: 'Asia/Karachi' });
      const full = await service.update(id, { timezone: null });

      expect(await stored(client, id)).toEqual({ timezone: null });
      expect(full.timezone).toBeNull();
      expect((await service.get(id)).timezone).toBeNull();
    });
  });

  it('an unknown key in the patch stores nothing', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);
      await service.update(id, { bogus: 1 } as never);
      expect(await stored(client, id)).toEqual({});
    });
  });

  it('a bad stored value never reaches the client', async () => {
    await run(async (service, client) => {
      const id = await seedUser(client);
      await client.query(
        `UPDATE users SET preferences = '{"theme":"dark","weekStart":"friday","x":1}' WHERE id = $1`,
        [id],
      );
      expect(await service.get(id)).toEqual({
        ...DEFAULT_PREFERENCES,
        theme: 'dark',
      });
    });
  });
});
