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
 *   0089  workspace gains approval_policy, shorten_links_default,
 *         utm_default, invite_link_code, invite_link_enabled;
 *         workspace_invitations gains message.
 *   0090  workspace_labels (the catalogue) and post_labels (the join),
 *         filled from posts.metadata.labels.
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
const FILE_0089 = '0089_workspace_settings.sql';
const FILE_0090 = '0090_workspace_labels.sql';
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

/**
 * Runs `fn` and expects it to fail with the given Postgres error code. A
 * failed statement aborts the surrounding transaction, so it runs inside a
 * savepoint that is rolled back afterwards and the test can carry on.
 */
async function expectPgError(
  client: PoolClient,
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  await client.query('SAVEPOINT expect_error');
  await expect(fn()).rejects.toMatchObject({ code });
  await client.query('ROLLBACK TO SAVEPOINT expect_error');
}

describeDb('migration 0089 workspace settings', () => {
  const MIGRATIONS = [FILE_0089];

  it('0089 adds the five workspace columns and the invitation message column', async () => {
    const { workspaceColumns, invitationColumns } = await withRollbackDb(
      MIGRATIONS,
      async (_db, client) => {
        const columns = (table: string, names: string[]) =>
          client.query<{
            column_name: string;
            data_type: string;
            is_nullable: string;
            column_default: string | null;
            character_maximum_length: number | null;
          }>(
            `SELECT column_name, data_type, is_nullable, column_default,
                    character_maximum_length
               FROM information_schema.columns
              WHERE table_name = $1
                AND table_schema = current_schema()
                AND column_name = ANY($2::text[])
              ORDER BY column_name`,
            [table, names],
          );
        return {
          workspaceColumns: (
            await columns('workspace', [
              'approval_policy',
              'shorten_links_default',
              'utm_default',
              'invite_link_code',
              'invite_link_enabled',
            ])
          ).rows,
          invitationColumns: (
            await columns('workspace_invitations', ['message'])
          ).rows,
        };
      },
    );

    expect(workspaceColumns).toEqual([
      {
        column_name: 'approval_policy',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: "'none'::text",
        character_maximum_length: null,
      },
      {
        column_name: 'invite_link_code',
        data_type: 'character varying',
        is_nullable: 'YES',
        column_default: null,
        character_maximum_length: 32,
      },
      {
        column_name: 'invite_link_enabled',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
        character_maximum_length: null,
      },
      {
        column_name: 'shorten_links_default',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
        character_maximum_length: null,
      },
      {
        column_name: 'utm_default',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
        character_maximum_length: null,
      },
    ]);
    expect(invitationColumns).toEqual([
      {
        column_name: 'message',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
        character_maximum_length: null,
      },
    ]);
  });

  it('0089 leaves an existing workspace at none / false / false / NULL / false', async () => {
    const row = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const workspaceId = await seedWorkspace(client, ownerId);
      // Re-run the file with the workspace already in place, so the defaults
      // are proven on a row that existed before the migration.
      await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0089), 'utf8'));
      const r = await client.query<{
        approval_policy: string;
        shorten_links_default: boolean;
        utm_default: boolean;
        invite_link_code: string | null;
        invite_link_enabled: boolean;
      }>(
        `SELECT approval_policy, shorten_links_default, utm_default,
                invite_link_code, invite_link_enabled
           FROM workspace WHERE id = $1`,
        [workspaceId],
      );
      return r.rows[0];
    });

    expect(row).toEqual({
      approval_policy: 'none',
      shorten_links_default: false,
      utm_default: false,
      invite_link_code: null,
      invite_link_enabled: false,
    });
  });

  it.each(['none', 'members', 'everyone'])(
    '0089 accepts approval_policy %s',
    async (policy) => {
      const stored = await withRollbackDb(MIGRATIONS, async (_db, client) => {
        const ownerId = await seedUser(client);
        const workspaceId = await seedWorkspace(client, ownerId);
        await client.query(
          `UPDATE workspace SET approval_policy = $1 WHERE id = $2`,
          [policy, workspaceId],
        );
        const r = await client.query<{ approval_policy: string }>(
          `SELECT approval_policy FROM workspace WHERE id = $1`,
          [workspaceId],
        );
        return r.rows[0].approval_policy;
      });

      expect(stored).toBe(policy);
    },
  );

  it('0089 rejects an approval_policy outside none / members / everyone (23514)', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const workspaceId = await seedWorkspace(client, ownerId);
      await expectPgError(client, '23514', () =>
        client.query(
          `UPDATE workspace SET approval_policy = 'sometimes' WHERE id = $1`,
          [workspaceId],
        ),
      );
    });
  });

  it('0089 rejects two workspaces with the same invite_link_code (23505)', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const first = await seedWorkspace(client, ownerId);
      const second = await seedWorkspace(client, ownerId);
      const code = `c${rand()}${rand()}`;
      await client.query(
        `UPDATE workspace SET invite_link_code = $1 WHERE id = $2`,
        [code, first],
      );
      await expectPgError(client, '23505', () =>
        client.query(
          `UPDATE workspace SET invite_link_code = $1 WHERE id = $2`,
          [code, second],
        ),
      );
    });
  });

  it('0089 allows many workspaces without an invite_link_code', async () => {
    const count = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const first = await seedWorkspace(client, ownerId);
      const second = await seedWorkspace(client, ownerId);
      const r = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM workspace
          WHERE id IN ($1, $2) AND invite_link_code IS NULL`,
        [first, second],
      );
      return Number(r.rows[0].n);
    });

    expect(count).toBe(2);
  });

  it('0089 creates the unique index under the name the Drizzle schema uses', async () => {
    const indexes = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'workspace'
            AND schemaname = current_schema()
            AND indexname = 'workspace_invite_link_code_uq'`,
      );
      return r.rows;
    });

    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toMatch(/^CREATE UNIQUE INDEX/);
    expect(indexes[0].indexdef).toContain('(invite_link_code)');
  });
});

async function seedPost(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  metadata: unknown,
  createdAt: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, targets,
                        metadata, created_at)
     VALUES ($1, $2, 'draft', 'x', '[]'::jsonb, $3::jsonb, $4::timestamptz)
     RETURNING id`,
    [workspaceId, userId, JSON.stringify(metadata), createdAt],
  );
  return r.rows[0].id;
}

/** Re-runs the migration file on the seeded posts (the backfill under test). */
async function rerun0090(client: PoolClient): Promise<void> {
  await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0090), 'utf8'));
}

/**
 * The catalogue in first-sighting order. Labels from one post share a
 * created_at, so the tie is broken by palette position (colours are handed out
 * in sighting order), then by name under the C collation. Never by a plain
 * ORDER BY name, whose result depends on the database collation.
 */
async function cataloguePairs(
  client: PoolClient,
  workspaceId: string,
): Promise<Array<{ name: string; color: string }>> {
  const r = await client.query<{ name: string; color: string }>(
    `SELECT name, color FROM workspace_labels
      WHERE workspace_id = $1 AND deleted_at IS NULL
      ORDER BY created_at,
               array_position(
                 ARRAY['blue', 'orange', 'green', 'purple', 'pink', 'teal',
                       'red', 'grey'],
                 color
               ),
               name COLLATE "C"`,
    [workspaceId],
  );
  return r.rows;
}

async function labelNamesByPost(
  client: PoolClient,
  workspaceId: string,
): Promise<Record<string, string[]>> {
  const r = await client.query<{ post_id: string; name: string }>(
    `SELECT pl.post_id, l.name
       FROM post_labels pl
       JOIN workspace_labels l ON l.id = pl.label_id
      WHERE l.workspace_id = $1
      ORDER BY pl.post_id, l.name COLLATE "C"`,
    [workspaceId],
  );
  const out: Record<string, string[]> = {};
  for (const row of r.rows) (out[row.post_id] ??= []).push(row.name);
  return out;
}

async function countRows(client: PoolClient, table: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table}`,
  );
  return Number(r.rows[0].n);
}

describeDb('migration 0090 workspace labels', () => {
  const MIGRATIONS = [FILE_0090];

  it('0090 backfills one catalogue row per distinct label and one post_labels row per (post, label)', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      const other = await seedWorkspace(client, userId);
      const p1 = await seedPost(
        client,
        w,
        userId,
        { labels: ['Promo', 'launch'] },
        '2026-01-01T00:00:00Z',
      );
      const p2 = await seedPost(
        client,
        w,
        userId,
        { labels: ['promo'] },
        '2026-01-02T00:00:00Z',
      );
      await seedPost(
        client,
        w,
        userId,
        { labels: 'not-an-array' },
        '2026-01-03T00:00:00Z',
      );
      const p4 = await seedPost(
        client,
        w,
        userId,
        { labels: ['Launch', ' BTS '] },
        '2026-01-04T00:00:00Z',
      );
      // Another workspace's labels must never land in W's catalogue.
      await seedPost(
        client,
        other,
        userId,
        { labels: ['Promo', 'Other'] },
        '2026-01-05T00:00:00Z',
      );

      await rerun0090(client);

      const wJoin = await labelNamesByPost(client, w);
      return {
        wLabels: await cataloguePairs(client, w),
        otherLabels: await cataloguePairs(client, other),
        wJoin,
        wJoinTotal: Object.values(wJoin).flat().length,
        p1,
        p2,
        p4,
      };
    });

    // First-seen spelling (Promo, not promo; launch, not Launch), trimmed
    // ("BTS"), colours in palette order by first sighting.
    expect(result.wLabels).toEqual([
      { name: 'Promo', color: 'blue' },
      { name: 'launch', color: 'orange' },
      { name: 'BTS', color: 'green' },
    ]);
    expect(result.wJoinTotal).toBe(5);
    expect(result.wJoin[result.p1]).toEqual(['Promo', 'launch']);
    expect(result.wJoin[result.p2]).toEqual(['Promo']);
    expect(result.wJoin[result.p4]).toEqual(['BTS', 'launch']);
    expect(result.otherLabels).toEqual([
      { name: 'Promo', color: 'blue' },
      { name: 'Other', color: 'orange' },
    ]);
  });

  it('0090 collapses whitespace and drops empty, over-long and non-string labels', async () => {
    const forty = 'a'.repeat(40);
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      await seedPost(
        client,
        w,
        userId,
        {
          labels: [
            '  Hot   drinks ',
            '',
            '   ',
            3,
            null,
            'a'.repeat(41),
            forty,
          ],
        },
        '2026-01-01T00:00:00Z',
      );
      await rerun0090(client);
      return cataloguePairs(client, w);
    });

    expect(result.map((r) => r.name)).toEqual(['Hot drinks', forty]);
  });

  it('0090 gives the ninth label in a workspace the first colour again', async () => {
    const colours = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      await seedPost(
        client,
        w,
        userId,
        { labels: Array.from({ length: 9 }, (_v, i) => `label-${i + 1}`) },
        '2026-01-01T00:00:00Z',
      );
      await rerun0090(client);
      return (await cataloguePairs(client, w)).map((r) => r.color);
    });

    expect(colours).toEqual([
      'blue',
      'orange',
      'green',
      'purple',
      'pink',
      'teal',
      'red',
      'grey',
      'blue',
    ]);
  });

  it('0090 run again creates no duplicates', async () => {
    const counts = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      await seedPost(
        client,
        w,
        userId,
        { labels: ['Promo', 'launch'] },
        '2026-01-01T00:00:00Z',
      );
      await seedPost(
        client,
        w,
        userId,
        { labels: ['promo'] },
        '2026-01-02T00:00:00Z',
      );
      await rerun0090(client);
      const first = {
        labels: await countRows(client, 'workspace_labels'),
        joins: await countRows(client, 'post_labels'),
      };
      await rerun0090(client);
      await rerun0090(client);
      const again = {
        labels: await countRows(client, 'workspace_labels'),
        joins: await countRows(client, 'post_labels'),
      };
      return { first, again };
    });

    expect(counts.first).toEqual({ labels: 2, joins: 3 });
    expect(counts.again).toEqual(counts.first);
  });

  it('0090 leaves posts.metadata.labels in place', async () => {
    const metadata = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      const postId = await seedPost(
        client,
        w,
        userId,
        { labels: ['Promo'], keep: 1 },
        '2026-01-01T00:00:00Z',
      );
      await rerun0090(client);
      const r = await client.query<{ metadata: unknown }>(
        `SELECT metadata FROM posts WHERE id = $1`,
        [postId],
      );
      return r.rows[0].metadata;
    });

    expect(metadata).toEqual({ labels: ['Promo'], keep: 1 });
  });

  it('0090 rejects a second live label whose name differs only by case (23505), but accepts it once the first is soft-deleted', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      await client.query(
        `INSERT INTO workspace_labels (workspace_id, name, color)
         VALUES ($1, 'Promo', 'blue')`,
        [w],
      );
      const insertLower = () =>
        client.query(
          `INSERT INTO workspace_labels (workspace_id, name, color)
           VALUES ($1, 'promo', 'orange')`,
          [w],
        );
      await expectPgError(client, '23505', insertLower);

      await client.query(
        `UPDATE workspace_labels SET deleted_at = now()
          WHERE workspace_id = $1 AND name = 'Promo'`,
        [w],
      );
      await expect(insertLower()).resolves.toBeDefined();

      // The same name in another workspace was never a clash.
      const other = await seedWorkspace(client, userId);
      await expect(
        client.query(
          `INSERT INTO workspace_labels (workspace_id, name, color)
           VALUES ($1, 'promo', 'orange')`,
          [other],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('0090 rejects a colour outside the palette (23514)', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      await expectPgError(client, '23514', () =>
        client.query(
          `INSERT INTO workspace_labels (workspace_id, name, color)
           VALUES ($1, 'Promo', 'cyan')`,
          [w],
        ),
      );
    });
  });

  it('0090 removes post_labels rows with their post and with their label', async () => {
    const counts = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      const p1 = await seedPost(
        client,
        w,
        userId,
        { labels: ['A', 'B'] },
        '2026-01-01T00:00:00Z',
      );
      await seedPost(
        client,
        w,
        userId,
        { labels: ['A'] },
        '2026-01-02T00:00:00Z',
      );
      await rerun0090(client);
      const before = await countRows(client, 'post_labels');
      await client.query(`DELETE FROM posts WHERE id = $1`, [p1]);
      const afterPost = await countRows(client, 'post_labels');
      await client.query(
        `DELETE FROM workspace_labels WHERE workspace_id = $1 AND name = 'A'`,
        [w],
      );
      const afterLabel = await countRows(client, 'post_labels');
      return { before, afterPost, afterLabel };
    });

    expect(counts).toEqual({ before: 3, afterPost: 1, afterLabel: 0 });
  });
});
