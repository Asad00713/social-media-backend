import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';

/**
 * Settings redesign, Part A: one describeDb block per migration.
 *
 *   0092  users gains preferences, password_changed_at,
 *         notifications_paused_until and deleted_at, and the Planner week
 *         start is copied into preferences.weekStart.
 *   0093  workspace gains approval_policy, shorten_links_default,
 *         utm_default, invite_link_code, invite_link_enabled;
 *         workspace_invitations gains message.
 *   0094  workspace_labels (the catalogue) and post_labels (the join),
 *         filled from posts.metadata.labels.
 *   0095  every foreign key to users stops blocking a user delete: actor
 *         columns SET NULL, the Canva grant CASCADE, and
 *         workspace.owner_id RESTRICT (never deleted by accident).
 *   0097  validates the foreign keys 0094 and 0095 add NOT VALID, in a
 *         transaction of its own (no long lock in those files).
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
const FILE_0092 = '0092_user_account_settings.sql';
const FILE_0093 = '0093_workspace_settings.sql';
const FILE_0094 = '0094_workspace_labels.sql';
const FILE_0095 = '0095_users_fk_set_null.sql';
const FILE_0097 = '0097_users_fk_validate.sql';
/** posts.deleted_at, which the 0094 backfill reads. */
const FILE_0088 = '0088_soft_delete_posts_workspaces.sql';
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
async function rerun0092(client: PoolClient): Promise<void> {
  await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0092), 'utf8'));
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

describeDb('migration 0092 user account settings', () => {
  const MIGRATIONS = ['0043_planner_preferences.sql', FILE_0092];

  it('0092 adds the four users columns with their defaults', async () => {
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

  it('0092 copies planner weekStartsOn into preferences.weekStart from the most recently updated row', async () => {
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
      await rerun0092(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'monday' });
  });

  it('0092 maps weekStartsOn 0 to sunday', async () => {
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
      await rerun0092(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'sunday' });
  });

  it('0092 does not overwrite a weekStart the user already chose', async () => {
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
      await rerun0092(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({ weekStart: 'sunday', theme: 'x' });
  });

  it('0092 ignores planner_preferences rows without weekStartsOn', async () => {
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
      await rerun0092(client);
      return preferencesOf(client, userId);
    });

    expect(prefs).toEqual({});
  });

  it('0092 leaves preferences {} when the user has no planner_preferences row', async () => {
    const prefs = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      await rerun0092(client);
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

describeDb('migration 0093 workspace settings', () => {
  const MIGRATIONS = [FILE_0093];

  it('0093 adds the five workspace columns and the invitation message column', async () => {
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

  it('0093 leaves an existing workspace at none / false / false / NULL / false', async () => {
    const row = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const ownerId = await seedUser(client);
      const workspaceId = await seedWorkspace(client, ownerId);
      // Re-run the file with the workspace already in place, so the defaults
      // are proven on a row that existed before the migration.
      await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0093), 'utf8'));
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
    '0093 accepts approval_policy %s',
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

  it('0093 rejects an approval_policy outside none / members / everyone (23514)', async () => {
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

  it('0093 rejects two workspaces with the same invite_link_code (23505)', async () => {
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

  it('0093 allows many workspaces without an invite_link_code', async () => {
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

  it('0093 creates the unique index under the name the Drizzle schema uses', async () => {
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
async function rerun0094(client: PoolClient): Promise<void> {
  await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0094), 'utf8'));
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

/** The foreign keys 0094 adds, last and NOT VALID. */
const LABEL_FKS = [
  'workspace_labels_workspace_id_fkey',
  'workspace_labels_created_by_fkey',
  'post_labels_post_id_fkey',
  'post_labels_label_id_fkey',
];

async function fkValidity(
  client: PoolClient,
  names: string[],
): Promise<Record<string, boolean>> {
  const r = await client.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
      WHERE contype = 'f' AND conname = ANY($1::text[])`,
    [names],
  );
  return Object.fromEntries(r.rows.map((x) => [x.conname, x.convalidated]));
}

describeDb('migration 0094 workspace labels', () => {
  const MIGRATIONS = [FILE_0088, FILE_0094];

  it('0094 skips soft-deleted posts: their labels reach neither the catalogue nor post_labels', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      const live = await seedPost(
        client,
        w,
        userId,
        { labels: ['Kept'] },
        '2026-01-01T00:00:00Z',
      );
      const gone = await seedPost(
        client,
        w,
        userId,
        { labels: ['Kept', 'OnlyOnDeleted'] },
        '2026-01-02T00:00:00Z',
      );
      await client.query(`UPDATE posts SET deleted_at = now() WHERE id = $1`, [
        gone,
      ]);
      await rerun0094(client);
      return {
        labels: await cataloguePairs(client, w),
        join: await labelNamesByPost(client, w),
        live,
        gone,
      };
    });

    expect(result.labels).toEqual([{ name: 'Kept', color: 'blue' }]);
    expect(result.join[result.live]).toEqual(['Kept']);
    expect(result.join[result.gone]).toBeUndefined();
  });

  it('0094 skips posts whose WORKSPACE is soft-deleted: a purge could hard-delete them before the foreign keys exist', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const live = await seedWorkspace(client, userId);
      const doomed = await seedWorkspace(client, userId);
      const livePost = await seedPost(
        client,
        live,
        userId,
        { labels: ['Kept'] },
        '2026-01-01T00:00:00Z',
      );
      const doomedPost = await seedPost(
        client,
        doomed,
        userId,
        { labels: ['Kept', 'OnlyInDoomed'] },
        '2026-01-02T00:00:00Z',
      );
      // The post itself is live; only its workspace is deleted.
      await client.query(
        `UPDATE workspace SET deleted_at = now() WHERE id = $1`,
        [doomed],
      );
      await rerun0094(client);
      return {
        liveLabels: await cataloguePairs(client, live),
        doomedLabels: await cataloguePairs(client, doomed),
        join: await labelNamesByPost(client, live),
        doomedJoin: await labelNamesByPost(client, doomed),
        livePost,
        doomedPost,
      };
    });

    expect(result.liveLabels).toEqual([{ name: 'Kept', color: 'blue' }]);
    expect(result.join[result.livePost]).toEqual(['Kept']);
    expect(result.doomedLabels).toEqual([]);
    expect(result.doomedJoin[result.doomedPost]).toBeUndefined();
  });

  it('0094 adds its foreign keys NOT VALID (no scan under the lock), and they already refuse a bad row', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const validity = await fkValidity(client, LABEL_FKS);
      let code: string | undefined;
      await client.query('SAVEPOINT bad_row');
      try {
        await client.query(
          `INSERT INTO post_labels (post_id, label_id)
           VALUES (gen_random_uuid(), gen_random_uuid())`,
        );
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      await client.query('ROLLBACK TO SAVEPOINT bad_row');
      return { validity, code };
    });

    expect(result.validity).toEqual(
      Object.fromEntries(LABEL_FKS.map((n) => [n, false])),
    );
    expect(result.code).toBe('23503');
  });

  it('0094 backfills one catalogue row per distinct label and one post_labels row per (post, label)', async () => {
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

      await rerun0094(client);

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

  it('0094 collapses whitespace and drops empty, over-long and non-string labels', async () => {
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
      await rerun0094(client);
      return cataloguePairs(client, w);
    });

    expect(result.map((r) => r.name)).toEqual(['Hot drinks', forty]);
  });

  it('0094 gives the ninth label in a workspace the first colour again', async () => {
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
      await rerun0094(client);
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

  it('0094 run again creates no duplicates', async () => {
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
      await rerun0094(client);
      const first = {
        labels: await countRows(client, 'workspace_labels'),
        joins: await countRows(client, 'post_labels'),
      };
      await rerun0094(client);
      await rerun0094(client);
      const again = {
        labels: await countRows(client, 'workspace_labels'),
        joins: await countRows(client, 'post_labels'),
      };
      return { first, again };
    });

    expect(counts.first).toEqual({ labels: 2, joins: 3 });
    expect(counts.again).toEqual(counts.first);
  });

  it('0094 leaves posts.metadata.labels in place', async () => {
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
      await rerun0094(client);
      const r = await client.query<{ metadata: unknown }>(
        `SELECT metadata FROM posts WHERE id = $1`,
        [postId],
      );
      return r.rows[0].metadata;
    });

    expect(metadata).toEqual({ labels: ['Promo'], keep: 1 });
  });

  it('0094 rejects a second live label whose name differs only by case (23505), but accepts it once the first is soft-deleted', async () => {
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

  it('0094 rejects a colour outside the palette (23514)', async () => {
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

  it('0094 removes post_labels rows with their post and with their label', async () => {
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
      await rerun0094(client);
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

/** The six actor columns 0095 moves to SET NULL / CASCADE, and owner_id. */
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

describeDb('migration 0095 user foreign keys', () => {
  const MIGRATIONS = [FILE_0095];

  it('0095 leaves no foreign key to users at NO ACTION', async () => {
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

  it('0095 gives each listed column exactly one foreign key to users, with the planned action', async () => {
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

  it('0095 makes workspace.owner_id ON DELETE RESTRICT', async () => {
    const actions = await withRollbackDb(MIGRATIONS, (_db, client) =>
      userFkActions(client, 'workspace', 'owner_id'),
    );

    expect(actions).toEqual(['r']);
  });

  it('0095 lets workspace_invitations.invited_by be NULL', async () => {
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

  it('0095 hard-deleting a non-owner who invited, changed a plan, triggered usage, reviewed a drip and connected Canva succeeds', async () => {
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
  it('0095 refuses to delete a user who owns a workspace (23503 on workspace_owner_id_fkey), and the workspace survives', async () => {
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

/** The constraint names 0095 writes, `<table>_<column>_fkey`. */
const USER_FKS = USER_FK_ACTIONS.map(
  ({ table, column }) => `${table}_${column}_fkey`,
);

describeDb(
  'migration 0095 locks: NOT VALID, and a guard that names the table',
  () => {
    it('0095 leaves its foreign keys NOT VALID: no table is scanned while users is held ACCESS EXCLUSIVE', async () => {
      const validity = await withRollbackDb([FILE_0095], (_db, client) =>
        fkValidity(client, USER_FKS),
      );
      // canva_connections may not exist in this database (created by push).
      expect(Object.keys(validity)).toEqual(
        expect.arrayContaining(USER_FKS.filter((n) => !n.startsWith('canva_'))),
      );
      for (const [name, valid] of Object.entries(validity)) {
        expect([name, valid]).toEqual([name, false]);
      }
    });

    it('0095 fails the boot naming the table, column and constraint a NO ACTION key is on', async () => {
      const message = await withRollbackDb([FILE_0095], async (_db, client) => {
        await client.query(
          `CREATE TABLE fk_guard_probe (id serial PRIMARY KEY,
           made_by uuid CONSTRAINT fk_guard_probe_made_by_fkey REFERENCES users (id))`,
        );
        await client.query('SAVEPOINT guard');
        try {
          await client.query(
            readFileSync(join(MIGRATIONS_DIR, FILE_0095), 'utf8'),
          );
          return null;
        } catch (err) {
          return (err as Error).message;
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT guard');
        }
      });

      expect(message).toContain(
        'table fk_guard_probe, column made_by (constraint fk_guard_probe_made_by_fkey)',
      );
    });
  },
);

describeDb(
  'migration 0097 validates the NOT VALID user and label foreign keys',
  () => {
    const MIGRATIONS = [FILE_0088, FILE_0094, FILE_0095, FILE_0097];

    it('0097 validates every key 0094 and 0095 left NOT VALID (applied twice: idempotent)', async () => {
      const validity = await withRollbackDb(MIGRATIONS, (_db, client) =>
        fkValidity(client, [...USER_FKS, ...LABEL_FKS]),
      );
      for (const name of [
        ...USER_FKS.filter((n) => !n.startsWith('canva_')),
        ...LABEL_FKS,
      ]) {
        expect([name, validity[name]]).toEqual([name, true]);
      }
    });

    /**
     * Seeds rows that predate the label foreign keys (written while they were
     * absent): the keys are dropped, orphans inserted, the keys re-added NOT
     * VALID exactly as 0094 leaves them.
     */
    async function seedLabelOrphans(client: PoolClient) {
      await client.query(
        `ALTER TABLE post_labels DROP CONSTRAINT post_labels_post_id_fkey,
                                 DROP CONSTRAINT post_labels_label_id_fkey`,
      );
      await client.query(
        `ALTER TABLE workspace_labels
           DROP CONSTRAINT workspace_labels_workspace_id_fkey,
           DROP CONSTRAINT workspace_labels_created_by_fkey`,
      );
      const userId = await seedUser(client);
      const w = await seedWorkspace(client, userId);
      const post = await seedPost(
        client,
        w,
        userId,
        {},
        '2026-01-01T00:00:00Z',
      );
      const insertLabel = async (
        workspaceId: string,
        name: string,
        createdBy: string | null,
      ) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO workspace_labels (workspace_id, name, color, created_by)
             VALUES ($1, $2, 'blue', $3) RETURNING id`,
            [workspaceId, name, createdBy],
          )
        ).rows[0].id;
      const goodLabel = await insertLabel(w, 'good', userId);
      // created_by names a user that is gone: SET NULL semantics.
      const orphanCreator = await insertLabel(w, 'ghost-author', randomUUID());
      // A label whose workspace was purged, with a join row on it.
      const orphanWorkspaceLabel = await insertLabel(
        randomUUID(),
        'ghost-workspace',
        null,
      );
      await client.query(
        `INSERT INTO post_labels (post_id, label_id) VALUES ($1, $2), ($1, $3)`,
        [post, goodLabel, orphanCreator],
      );
      // A join row whose post is gone, one whose label is gone, and one on
      // the purged workspace's label.
      await client.query(
        `INSERT INTO post_labels (post_id, label_id)
         VALUES (gen_random_uuid(), $1), ($2, gen_random_uuid()),
                (gen_random_uuid(), $3)`,
        [goodLabel, post, orphanWorkspaceLabel],
      );
      await client.query(
        `ALTER TABLE workspace_labels
           ADD CONSTRAINT workspace_labels_workspace_id_fkey
             FOREIGN KEY (workspace_id) REFERENCES workspace (id)
             ON DELETE CASCADE NOT VALID,
           ADD CONSTRAINT workspace_labels_created_by_fkey
             FOREIGN KEY (created_by) REFERENCES users (id)
             ON DELETE SET NULL NOT VALID`,
      );
      await client.query(
        `ALTER TABLE post_labels
           ADD CONSTRAINT post_labels_post_id_fkey
             FOREIGN KEY (post_id) REFERENCES posts (id)
             ON DELETE CASCADE NOT VALID,
           ADD CONSTRAINT post_labels_label_id_fkey
             FOREIGN KEY (label_id) REFERENCES workspace_labels (id)
             ON DELETE CASCADE NOT VALID`,
      );
      return { userId, w, post, goodLabel, orphanCreator };
    }

    it('0097 removes orphan label rows (a purge between the 0094 backfill and its keys), then validates', async () => {
      const result = await withRollbackDb(
        [FILE_0088, FILE_0094, FILE_0095],
        async (_db, client) => {
          const seeded = await seedLabelOrphans(client);
          const before = await fkValidity(client, LABEL_FKS);
          await client.query(
            readFileSync(join(MIGRATIONS_DIR, FILE_0097), 'utf8'),
          );
          const labels = await client.query<{
            id: string;
            created_by: string | null;
          }>(`SELECT id, created_by FROM workspace_labels ORDER BY name`);
          const joins = await client.query<{
            post_id: string;
            label_id: string;
          }>(`SELECT post_id, label_id FROM post_labels ORDER BY label_id`);
          return {
            seeded,
            before,
            after: await fkValidity(client, LABEL_FKS),
            labels: labels.rows,
            joins: joins.rows,
          };
        },
      );

      expect(result.before).toEqual(
        Object.fromEntries(LABEL_FKS.map((n) => [n, false])),
      );
      expect(result.after).toEqual(
        Object.fromEntries(LABEL_FKS.map((n) => [n, true])),
      );
      const { goodLabel, orphanCreator, post, userId } = result.seeded;
      // The label of a purged workspace is gone; the other two stay, the
      // ghost author's created_by cleared (ON DELETE SET NULL), the real
      // one's kept.
      expect(result.labels).toHaveLength(2);
      expect(result.labels).toEqual(
        expect.arrayContaining([
          { id: goodLabel, created_by: userId },
          { id: orphanCreator, created_by: null },
        ]),
      );
      // Only the two join rows that point at a live post AND a live label.
      expect(result.joins).toHaveLength(2);
      expect(result.joins.every((j) => j.post_id === post)).toBe(true);
      expect(result.joins.map((j) => j.label_id).sort()).toEqual(
        [goodLabel, orphanCreator].sort(),
      );
    });

    it('0097 leaves clean label tables untouched', async () => {
      const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
        const userId = await seedUser(client);
        const w = await seedWorkspace(client, userId);
        await seedPost(
          client,
          w,
          userId,
          { labels: ['A'] },
          '2026-01-01T00:00:00Z',
        );
        await rerun0094(client);
        // MIGRATIONS ran 0097 before the post existed; run it again now.
        await client.query(
          readFileSync(join(MIGRATIONS_DIR, FILE_0097), 'utf8'),
        );
        return {
          labels: await countRows(client, 'workspace_labels'),
          joins: await countRows(client, 'post_labels'),
        };
      });
      expect(result.labels).toBe(1);
      expect(result.joins).toBe(1);
    });

    it('0097 still fails loudly, naming the constraint, on a USER key violation it does not repair, and changes nothing', async () => {
      const result = await withRollbackDb(
        [FILE_0088, FILE_0094, FILE_0095],
        async (_db, client) => {
          // A row that predates the constraint: written while it was absent.
          await client.query(
            `ALTER TABLE workspace_invitations
               DROP CONSTRAINT workspace_invitations_invited_by_fkey`,
          );
          const userId = await seedUser(client);
          const w = await seedWorkspace(client, userId);
          await client.query(
            `INSERT INTO workspace_invitations
               (workspace_id, email, invited_by, token, expires_at)
             VALUES ($1, $2, gen_random_uuid(), $3, now() + interval '7 days')`,
            [w, `${rand()}@example.test`, rand() + rand()],
          );
          await client.query(
            `ALTER TABLE workspace_invitations
               ADD CONSTRAINT workspace_invitations_invited_by_fkey
               FOREIGN KEY (invited_by) REFERENCES users (id)
               ON DELETE SET NULL NOT VALID`,
          );
          await client.query('SAVEPOINT v');
          let error: { code?: string; constraint?: string } | null = null;
          try {
            await client.query(
              readFileSync(join(MIGRATIONS_DIR, FILE_0097), 'utf8'),
            );
          } catch (err) {
            error = err as { code?: string; constraint?: string };
          }
          await client.query('ROLLBACK TO SAVEPOINT v');
          return {
            error,
            validity: await fkValidity(client, [
              'workspace_invitations_invited_by_fkey',
            ]),
          };
        },
      );

      expect(result.error).toMatchObject({
        code: '23503',
        constraint: 'workspace_invitations_invited_by_fkey',
      });
      expect(result.validity.workspace_invitations_invited_by_fkey).toBe(false);
    });
  },
);

/**
 * 0096 recounts workspace_usage.members_count as ACCEPTED non-guest members,
 * so workspaces that counted their guests before guests became free are put
 * right, and only rows that differ are written.
 */
const FILE_0096 = '0096_guest_seat_recount.sql';

describeDb('0096 guest seat recount', () => {
  async function seedUsage(
    client: PoolClient,
    workspaceId: string,
    membersCount: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO workspace_usage
         (workspace_id, channels_limit, members_limit, members_count,
          last_calculated_at, updated_at)
       VALUES ($1, 3, 5, $2, '2020-01-01', '2020-01-01')`,
      [workspaceId, membersCount],
    );
  }

  async function seedRow(
    client: PoolClient,
    workspaceId: string,
    role: 'ADMIN' | 'MEMBER' | 'GUEST',
    status: 'ACCEPTED' | 'PENDING' | 'REMOVED',
  ): Promise<void> {
    await client.query(
      `INSERT INTO workspace_invitations
         (workspace_id, email, role, status, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [workspaceId, `${rand()}@example.test`, role, status, rand() + rand()],
    );
  }

  const usageOf = async (client: PoolClient, workspaceId: string) =>
    (
      await client.query<{ members_count: number; updated: boolean }>(
        `SELECT members_count, updated_at > '2020-01-02' AS updated
           FROM workspace_usage WHERE workspace_id = $1`,
        [workspaceId],
      )
    ).rows[0];

  it('counts ACCEPTED non-guests only, and writes only workspaces whose count differed', async () => {
    // 0080: REMOVED status. 0092/0093: columns the full-row inserts name.
    // 0095: invited_by is NULLable, so a seeded row needs no inviter.
    const result = await withRollbackDb(
      ['0080_member_soft_removal.sql', FILE_0092, FILE_0093, FILE_0095],
      async (_db, client) => {
        const owner = await seedUser(client);
        // 2 members + 1 admin + 2 guests accepted, plus a pending member, a
        // pending guest and a removed member: 3 seats, counted as 5 before.
        const drifted = await seedWorkspace(client, owner);
        await seedUsage(client, drifted, 5);
        await seedRow(client, drifted, 'MEMBER', 'ACCEPTED');
        await seedRow(client, drifted, 'MEMBER', 'ACCEPTED');
        await seedRow(client, drifted, 'ADMIN', 'ACCEPTED');
        await seedRow(client, drifted, 'GUEST', 'ACCEPTED');
        await seedRow(client, drifted, 'GUEST', 'ACCEPTED');
        await seedRow(client, drifted, 'MEMBER', 'PENDING');
        await seedRow(client, drifted, 'GUEST', 'PENDING');
        await seedRow(client, drifted, 'MEMBER', 'REMOVED');

        // Already right: must not be touched (updated_at stays put).
        const correct = await seedWorkspace(client, owner);
        await seedUsage(client, correct, 1);
        await seedRow(client, correct, 'MEMBER', 'ACCEPTED');
        await seedRow(client, correct, 'GUEST', 'ACCEPTED');

        // Only guests: counted 2, should be 0. An under-count heals up too.
        const guestsOnly = await seedWorkspace(client, owner);
        await seedUsage(client, guestsOnly, 2);
        await seedRow(client, guestsOnly, 'GUEST', 'ACCEPTED');
        await seedRow(client, guestsOnly, 'GUEST', 'ACCEPTED');

        const undercounted = await seedWorkspace(client, owner);
        await seedUsage(client, undercounted, 0);
        await seedRow(client, undercounted, 'ADMIN', 'ACCEPTED');

        await client.query(
          readFileSync(join(MIGRATIONS_DIR, FILE_0096), 'utf8'),
        );
        const firstRun = {
          drifted: await usageOf(client, drifted),
          correct: await usageOf(client, correct),
          guestsOnly: await usageOf(client, guestsOnly),
          undercounted: await usageOf(client, undercounted),
        };

        // A second run changes nothing: put a marker on a row and see it kept.
        await client.query(
          `UPDATE workspace_usage SET updated_at = '2020-01-01' WHERE workspace_id = $1`,
          [drifted],
        );
        await client.query(
          readFileSync(join(MIGRATIONS_DIR, FILE_0096), 'utf8'),
        );
        return { firstRun, secondRun: await usageOf(client, drifted) };
      },
    );

    expect(result.firstRun.drifted).toEqual({
      members_count: 3,
      updated: true,
    });
    expect(result.firstRun.correct).toEqual({
      members_count: 1,
      updated: false,
    });
    expect(result.firstRun.guestsOnly).toEqual({
      members_count: 0,
      updated: true,
    });
    expect(result.firstRun.undercounted).toEqual({
      members_count: 1,
      updated: true,
    });
    expect(result.secondRun).toEqual({ members_count: 3, updated: false });
  });
});

/*
 * Settings redesign, Part B.
 *
 *   0098  user_sessions: one row per sign-in, so a session can be listed and
 *         revoked by its `sid`.
 *   0099  two-step sign-in: six users columns, known_devices trust,
 *         user_backup_codes and login_challenges.
 */
const FILE_0098 = '0098_user_sessions.sql';

describeDb('0098 user_sessions', () => {
  it('creates the table, the CHECK and the partial live index', async () => {
    const result = await withRollbackDb([FILE_0098], async (_db, client) => {
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'user_sessions'
          ORDER BY ordinal_position`,
      );
      const userId = await seedUser(client);
      await expectPgError(client, '23514', () =>
        client.query(
          `INSERT INTO user_sessions (user_id, label, device_type, expires_at)
           VALUES ($1, 'Chrome on Windows', 'phone', now() + interval '30 days')`,
          [userId],
        ),
      );
      const ok = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO user_sessions (user_id, label, device_type, expires_at)
         VALUES ($1, 'Chrome on Windows', 'desktop', now() + interval '30 days')
         RETURNING id, created_at`,
        [userId],
      );
      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'user_sessions'
            AND indexname = 'user_sessions_user_live_idx'`,
      );
      // ON DELETE CASCADE: deleting the user removes the row.
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      const left = await client.query(
        `SELECT 1 FROM user_sessions WHERE id = $1`,
        [ok.rows[0].id],
      );
      return {
        columns: columns.rows,
        inserted: ok.rows[0],
        index: index.rows,
        left: left.rowCount,
      };
    });

    expect(result.columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO' },
      {
        column_name: 'device_hash',
        data_type: 'character',
        is_nullable: 'YES',
      },
      {
        column_name: 'label',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      { column_name: 'device_type', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'ip', data_type: 'character varying', is_nullable: 'YES' },
      {
        column_name: 'country',
        data_type: 'character varying',
        is_nullable: 'YES',
      },
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'last_used_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'expires_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'revoked_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
      },
    ]);
    expect(result.inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.index).toHaveLength(1);
    expect(result.index[0].indexdef).toContain('(user_id)');
    expect(result.index[0].indexdef).toContain('WHERE (revoked_at IS NULL)');
    expect(result.left).toBe(0);
  });

  it('applies twice without error (idempotent)', async () => {
    // The harness has already applied the file twice; run it a third time.
    const indexes = await withRollbackDb([FILE_0098], async (_db, client) => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, FILE_0098), 'utf8'));
      const r = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'user_sessions'
          ORDER BY indexname`,
      );
      return r.rows.map((x) => x.indexname);
    });
    expect(indexes).toEqual([
      'user_sessions_pkey',
      'user_sessions_user_live_idx',
    ]);
  });
});

const FILE_0099 = '0099_two_factor.sql';
/** known_devices, which 0099 alters. */
const FILE_0072 = '0072_known_devices.sql';

describeDb('0099 two_factor', () => {
  const MIGRATIONS = [FILE_0072, FILE_0098, FILE_0099];

  it('adds six users columns with mfa_failures NOT NULL DEFAULT 0', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'users'
            AND column_name IN ('totp_secret_enc', 'totp_pending_secret_enc',
                                'totp_enabled_at', 'totp_last_step',
                                'mfa_failures', 'mfa_locked_until')
          ORDER BY column_name`,
      );
      const userId = await seedUser(client);
      const row = await client.query<{ mfa_failures: number }>(
        `SELECT mfa_failures FROM users WHERE id = $1`,
        [userId],
      );
      return { columns: columns.rows, failures: row.rows[0].mfa_failures };
    });

    const col = (
      column_name: string,
      data_type: string,
      is_nullable: string,
      column_default: string | null = null,
    ) => ({ column_name, data_type, is_nullable, column_default });
    expect(result.columns).toEqual([
      col('mfa_failures', 'integer', 'NO', '0'),
      col('mfa_locked_until', 'timestamp with time zone', 'YES'),
      col('totp_enabled_at', 'timestamp with time zone', 'YES'),
      col('totp_last_step', 'bigint', 'YES'),
      col('totp_pending_secret_enc', 'text', 'YES'),
      col('totp_secret_enc', 'text', 'YES'),
    ]);
    expect(result.failures).toBe(0);
  });

  it('adds known_devices.mfa_trusted_until', async () => {
    const columns = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'known_devices' AND column_name = 'mfa_trusted_until'`,
      );
      return r.rows;
    });
    expect(columns).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
  });

  it('login_challenges.purpose accepts mfa and admin_email and rejects anything else', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      const insert = (purpose: string) =>
        client.query<{ attempts: number; device_hash: string | null }>(
          `INSERT INTO login_challenges (user_id, purpose, expires_at)
           VALUES ($1, $2, now() + interval '5 minutes')
           RETURNING attempts, device_hash`,
          [userId, purpose],
        );
      const mfa = await insert('mfa');
      const admin = await insert('admin_email');
      await expectPgError(client, '23514', () => insert('x'));
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'login_challenges' ORDER BY ordinal_position`,
      );
      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'login_challenges'
            AND indexname = 'login_challenges_user_idx'`,
      );
      return {
        mfa: mfa.rows[0],
        admin: admin.rowCount,
        columns: columns.rows,
        index: index.rows,
      };
    });

    expect(result.mfa).toEqual({ attempts: 0, device_hash: null });
    expect(result.admin).toBe(1);
    const col = (
      column_name: string,
      data_type: string,
      is_nullable: string,
    ) => ({
      column_name,
      data_type,
      is_nullable,
    });
    expect(result.columns).toEqual([
      col('id', 'uuid', 'NO'),
      col('user_id', 'uuid', 'NO'),
      col('purpose', 'text', 'NO'),
      col('attempts', 'integer', 'NO'),
      col('device_hash', 'character', 'YES'),
      col('expires_at', 'timestamp with time zone', 'NO'),
      col('consumed_at', 'timestamp with time zone', 'YES'),
      col('created_at', 'timestamp with time zone', 'NO'),
    ]);
    expect(result.index).toHaveLength(1);
    expect(result.index[0].indexdef).toContain('(user_id)');
  });

  it('user_backup_codes has the partial index WHERE used_at IS NULL', async () => {
    const result = await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const userId = await seedUser(client);
      await client.query(
        `INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, 'a'.repeat(64)],
      );
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'user_backup_codes' ORDER BY ordinal_position`,
      );
      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'user_backup_codes' AND indexdef LIKE '%WHERE%'`,
      );
      // Both new tables cascade with the user.
      await client.query(
        `INSERT INTO login_challenges (user_id, purpose, expires_at)
         VALUES ($1, 'mfa', now() + interval '5 minutes')`,
        [userId],
      );
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      const left = await client.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM user_backup_codes WHERE user_id = $1)
              + (SELECT count(*) FROM login_challenges WHERE user_id = $1) AS n`,
        [userId],
      );
      return {
        columns: columns.rows,
        index: index.rows,
        left: Number(left.rows[0].n),
      };
    });

    const col = (
      column_name: string,
      data_type: string,
      is_nullable: string,
    ) => ({
      column_name,
      data_type,
      is_nullable,
    });
    expect(result.columns).toEqual([
      col('id', 'uuid', 'NO'),
      col('user_id', 'uuid', 'NO'),
      col('code_hash', 'character', 'NO'),
      col('used_at', 'timestamp with time zone', 'YES'),
      col('created_at', 'timestamp with time zone', 'NO'),
    ]);
    expect(result.index).toHaveLength(1);
    expect(result.index[0].indexdef).toContain('(user_id)');
    expect(result.index[0].indexdef).toContain('WHERE (used_at IS NULL)');
    expect(result.left).toBe(0);
  });
});
