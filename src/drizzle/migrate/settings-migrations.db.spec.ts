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
 *   0091  every foreign key to users stops blocking a user delete: actor
 *         columns SET NULL, the Canva grant CASCADE, and
 *         workspace.owner_id RESTRICT (never deleted by accident).
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
const FILE_0091 = '0091_users_fk_set_null.sql';
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
    const pairs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
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
      return cataloguePairs(client, w);
    });

    // Read as name -> colour, not by row order: label-1 and label-9 share a
    // colour, so the palette tie-break in cataloguePairs cannot order them.
    expect(Object.fromEntries(pairs.map((r) => [r.name, r.color]))).toEqual({
      'label-1': 'blue',
      'label-2': 'orange',
      'label-3': 'green',
      'label-4': 'purple',
      'label-5': 'pink',
      'label-6': 'teal',
      'label-7': 'red',
      'label-8': 'grey',
      'label-9': 'blue',
    });
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

/** The six actor columns 0091 moves to SET NULL / CASCADE, and owner_id. */
const USER_FK_ACTIONS = [
  { table: 'workspace_invitations', column: 'invited_by', action: 'n' },
  { table: 'subscription_changes', column: 'changed_by_user_id', action: 'n' },
  { table: 'usage_events', column: 'triggered_by_user_id', action: 'n' },
  { table: 'drip_posts', column: 'reviewed_by_id', action: 'n' },
  { table: 'drip_campaign_history', column: 'performed_by_id', action: 'n' },
  { table: 'canva_connections', column: 'user_id', action: 'c' },
  { table: 'workspace', column: 'owner_id', action: 'r' },
];

/**
 * Every foreign key from `table.column` to users, with its ON DELETE action
 * as pg_constraint spells it: a = NO ACTION, r = RESTRICT, c = CASCADE,
 * n = SET NULL.
 */
async function userFkActions(
  client: PoolClient,
  table: string,
  column: string,
): Promise<string[]> {
  const r = await client.query<{ confdeltype: string }>(
    `SELECT c.confdeltype
       FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.conrelid = to_regclass($1)
        AND c.confrelid = 'users'::regclass
        AND a.attname = $2`,
    [table, column],
  );
  return r.rows.map((row) => row.confdeltype);
}

async function countWhere(
  client: PoolClient,
  sql: string,
  id: string,
): Promise<number> {
  const r = await client.query<{ n: string }>(sql, [id]);
  return Number(r.rows[0].n);
}

describeDb('migration 0091 user foreign keys', () => {
  const MIGRATIONS = [FILE_0091];

  it('0091 leaves no foreign key to users at NO ACTION', async () => {
    const leftovers = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{ table_name: string; column_name: string }>(
        `SELECT c.conrelid::regclass::text AS table_name,
                a.attname AS column_name
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f'
            AND c.confrelid = 'users'::regclass
            AND c.confdeltype = 'a'`,
      );
      return r.rows;
    });

    expect(leftovers).toEqual([]);
  });

  it('0091 gives each listed column exactly one foreign key to users, with the planned action', async () => {
    const actions = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const out: Record<string, string[]> = {};
      for (const { table, column } of USER_FK_ACTIONS) {
        out[`${table}.${column}`] = await userFkActions(client, table, column);
      }
      return out;
    });

    // The harness applied the file twice: still one constraint per column.
    expect(actions).toEqual(
      Object.fromEntries(
        USER_FK_ACTIONS.map(({ table, column, action }) => [
          `${table}.${column}`,
          [action],
        ]),
      ),
    );
  });

  it('0091 makes workspace.owner_id ON DELETE RESTRICT', async () => {
    const actions = await withRollbackDb(MIGRATIONS, (_db, client) =>
      userFkActions(client, 'workspace', 'owner_id'),
    );

    expect(actions).toEqual(['r']);
  });

  it('0091 lets workspace_invitations.invited_by be NULL', async () => {
    const nullable = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'workspace_invitations'
            AND column_name = 'invited_by'`,
      );
      return r.rows[0].is_nullable;
    });

    expect(nullable).toBe('YES');
  });

  it('0091 hard-deleting a non-owner who invited, changed a plan, triggered usage, reviewed a drip and connected Canva succeeds', async () => {
    const after = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const workspaceId = await seedWorkspace(client, ownerId);
      const userId = await seedUser(client);

      const invitation = await client.query<{ id: string }>(
        `INSERT INTO workspace_invitations
           (workspace_id, email, invited_by, token, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [
          workspaceId,
          `i-${rand()}@example.com`,
          userId,
          `t-${rand()}${rand()}`,
        ],
      );

      // The subscription is the owner's; U only recorded a change on it.
      const planCode = `T${rand()}`;
      await client.query(
        `INSERT INTO plans (code, name, base_price_cents,
                            channels_per_workspace, members_per_workspace,
                            max_workspaces)
         VALUES ($1, 'Test', 0, 1, 1, 1)`,
        [planCode],
      );
      const subscription = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (user_id, plan_code, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [ownerId, planCode],
      );
      const change = await client.query<{ id: string }>(
        `INSERT INTO subscription_changes
           (subscription_id, change_type, changed_by_user_id)
         VALUES ($1, 'PLAN_UPGRADED', $2) RETURNING id`,
        [subscription.rows[0].id, userId],
      );

      const usage = await client.query<{ id: string }>(
        `INSERT INTO usage_events
           (workspace_id, event_type, resource_type, quantity_before,
            quantity_after, quantity_delta, triggered_by_user_id)
         VALUES ($1, 'MEMBER_ADDED', 'MEMBER', 0, 1, 1, $2) RETURNING id`,
        [workspaceId, userId],
      );

      // The campaign is the owner's; U only reviewed a post and acted on it.
      const campaign = await client.query<{ id: string }>(
        `INSERT INTO drip_campaigns
           (workspace_id, created_by_id, name, niche, target_channel_ids,
            occurrence_type, publish_time, start_date, end_date)
         VALUES ($1, $2, 'c', 'n', '[]'::jsonb, 'daily', '09:00',
                 '2026-01-01', '2026-01-31')
         RETURNING id`,
        [workspaceId, ownerId],
      );
      const campaignId = campaign.rows[0].id;
      const dripPost = await client.query<{ id: string }>(
        `INSERT INTO drip_posts
           (drip_campaign_id, occurrence_number, scheduled_date,
            scheduled_time, scheduled_at, ai_generation_at,
            email_notification_at, reviewed_by_id)
         VALUES ($1, 1, '2026-01-01', '09:00', now(), now(), now(), $2)
         RETURNING id`,
        [campaignId, userId],
      );
      const history = await client.query<{ id: string }>(
        `INSERT INTO drip_campaign_history
           (drip_campaign_id, action, performed_by_id)
         VALUES ($1, 'paused', $2) RETURNING id`,
        [campaignId, userId],
      );

      await client.query(
        `INSERT INTO canva_connections
           (workspace_id, user_id, access_token, refresh_token,
            token_expires_at)
         VALUES ($1, $2, 'a', 'r', now() + interval '1 hour')`,
        [workspaceId, userId],
      );

      const deleted = await client.query(`DELETE FROM users WHERE id = $1`, [
        userId,
      ]);

      const actor = async (sql: string, id: string) =>
        (await client.query<{ v: string | null }>(sql, [id])).rows[0]?.v;
      return {
        deleted: deleted.rowCount,
        invitedBy: await actor(
          `SELECT invited_by AS v FROM workspace_invitations WHERE id = $1`,
          invitation.rows[0].id,
        ),
        changedBy: await actor(
          `SELECT changed_by_user_id AS v FROM subscription_changes WHERE id = $1`,
          change.rows[0].id,
        ),
        triggeredBy: await actor(
          `SELECT triggered_by_user_id AS v FROM usage_events WHERE id = $1`,
          usage.rows[0].id,
        ),
        reviewedBy: await actor(
          `SELECT reviewed_by_id AS v FROM drip_posts WHERE id = $1`,
          dripPost.rows[0].id,
        ),
        performedBy: await actor(
          `SELECT performed_by_id AS v FROM drip_campaign_history WHERE id = $1`,
          history.rows[0].id,
        ),
        canvaRows: await countWhere(
          client,
          `SELECT count(*) AS n FROM canva_connections WHERE workspace_id = $1`,
          workspaceId,
        ),
        workspaceRows: await countWhere(
          client,
          `SELECT count(*) AS n FROM workspace WHERE id = $1`,
          workspaceId,
        ),
      };
    });

    // Every row survives with its actor cleared (a row that vanished would
    // read as undefined, not null); the person's own Canva grant goes with
    // them, and the owner's workspace is untouched.
    expect(after).toEqual({
      deleted: 1,
      invitedBy: null,
      changedBy: null,
      triggeredBy: null,
      reviewedBy: null,
      performedBy: null,
      canvaRows: 0,
      workspaceRows: 1,
    });
  });

  // Postgres reports an ON DELETE RESTRICT violation as 23503
  // (foreign_key_violation), exactly like NO ACTION; 23001 is never raised by
  // a foreign key. What tells RESTRICT apart is that it fires on the
  // statement itself, and the constraint named is the owner one.
  it('0091 refuses to delete a user who owns a workspace (23503 on workspace_owner_id_fkey), and the workspace survives', async () => {
    const survivors = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const workspaceId = await seedWorkspace(client, ownerId);
      await expectPgError(client, '23503', async () => {
        try {
          await client.query(`DELETE FROM users WHERE id = $1`, [ownerId]);
        } catch (err) {
          expect(err).toMatchObject({
            table: 'workspace',
            constraint: 'workspace_owner_id_fkey',
          });
          throw err;
        }
      });
      return {
        users: await countWhere(
          client,
          `SELECT count(*) AS n FROM users WHERE id = $1`,
          ownerId,
        ),
        workspaces: await countWhere(
          client,
          `SELECT count(*) AS n FROM workspace WHERE id = $1`,
          workspaceId,
        ),
      };
    });

    expect(survivors).toEqual({ users: 1, workspaces: 1 });
  });
});
