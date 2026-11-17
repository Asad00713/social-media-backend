import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';

/**
 * Settings redesign, Part A: one describeDb block per migration.
 *
 *   0088  users gains preferences, password_changed_at,
 *         notifications_paused_until and deleted_at, and the Planner week
 *         start is copied into preferences.weekStart.
 *
 * The harness applies each file twice BEFORE the test body runs, which proves
 * idempotency on an empty table only. A backfill test therefore seeds its
 * rows first and re-executes the file itself, so the copy runs on real data.
 */
const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
);
const FILE_0088 = '0088_user_account_settings.sql';
const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Rehman') RETURNING id`,
    [`u-${rand()}@example.com`],
  );
  return r.rows[0].id;
}

async function seedWorkspace(
  client: PoolClient,
  ownerId: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('w', $1, $2) RETURNING id`,
    [`w-${rand()}`, ownerId],
  );
  return r.rows[0].id;
}

async function seedPlannerPrefs(
  client: PoolClient,
  userId: string,
  workspaceId: string,
  prefs: object,
  updatedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO planner_preferences (user_id, workspace_id, prefs, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
    [userId, workspaceId, JSON.stringify(prefs), updatedAt],
  );
}

/** Re-runs the migration file on the seeded rows (the backfill under test). */
async function rerun0088(client: PoolClient): Promise<void> {
  await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0088), 'utf8'));
}

async function preferencesOf(
  client: PoolClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const r = await client.query<{ preferences: Record<string, unknown> }>(
    `SELECT preferences FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0].preferences;
}

describeDb('migration 0088 user account settings', () => {
  const MIGRATIONS = ['0043_planner_preferences.sql', FILE_0088];

  it('0088 adds the four users columns with their defaults', async () => {
    const columns = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'users'
            AND column_name IN ('preferences', 'password_changed_at',
                                'notifications_paused_until', 'deleted_at')
          ORDER BY column_name`,
      );
      return r.rows;
    });

    expect(columns).toEqual([
      {
        column_name: 'deleted_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'notifications_paused_until',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'password_changed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'preferences',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: "'{}'::jsonb",
      },
    ]);
  });

  it('0088 copies planner weekStartsOn into preferences.weekStart from the most recently updated row', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const older = await seedWorkspace(client, userId);
      const newer = await seedWorkspace(client, userId);
      await seedPlannerPrefs(
        client,
        userId,
        older,
        { weekStartsOn: 0 },
        '2026-01-01T00:00:00Z',
      );
      await seedPlannerPrefs(
        client,
        userId,
        newer,
        { weekStartsOn: 1 },
        '2026-06-01T00:00:00Z',
      );
      await rerun0088(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'monday' });
  });

  it('0088 maps weekStartsOn 0 to sunday', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const ws = await seedWorkspace(client, userId);
      await seedPlannerPrefs(
        client,
        userId,
        ws,
        { weekStartsOn: 0 },
        '2026-01-01T00:00:00Z',
      );
      await rerun0088(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'sunday' });
  });

  it('0088 does not overwrite a weekStart the user already chose', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const ws = await seedWorkspace(client, userId);
      await seedPlannerPrefs(
        client,
        userId,
        ws,
        { weekStartsOn: 1 },
        '2026-01-01T00:00:00Z',
      );
      await client.query(
        `UPDATE users SET preferences = '{"weekStart":"sunday","theme":"x"}'::jsonb WHERE id = $1`,
        [userId],
      );
      await rerun0088(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'sunday', theme: 'x' });
  });

  it('0088 ignores planner_preferences rows without weekStartsOn', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const ws = await seedWorkspace(client, userId);
      await seedPlannerPrefs(
        client,
        userId,
        ws,
        { view: 'week' },
        '2026-01-01T00:00:00Z',
      );
      await rerun0088(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({});
  });

  it('0088 leaves preferences {} when the user has no planner_preferences row', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      await rerun0088(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({});
  });
});
