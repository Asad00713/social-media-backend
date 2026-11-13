import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import {
  LIBRARY_MIGRATIONS,
  seedMediaItem,
  seedWorkspace,
} from '../../media-library/testing/library-db';
import { insightReports } from './insight-reports.schema';

const MIGRATION = '0064_insight_reports.sql';
const MIGRATIONS = [...LIBRARY_MIGRATIONS, MIGRATION];

type Row = Record<string, unknown>;

/** A valid weekly report; each rejection case overrides one column. */
function validRow(workspaceId: string, over: Row = {}): Row {
  return {
    workspace_id: workspaceId,
    name: 'Weekly client report',
    channel_ids: [11, 12],
    period: 'last_30_days',
    compare: 'usual',
    chart_metric: 'reach',
    sections: ['totals', 'chart'],
    cadence: 'weekly',
    weekday: 1,
    send_minute: 540,
    ...over,
  };
}

/** Inserts one row; the values are parameters, the column list is the keys. */
function insertReport(client: PoolClient, row: Row) {
  const cols = Object.keys(row);
  return client.query<{ id: string }>(
    `INSERT INTO insight_reports (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    cols.map((c) => row[c]),
  );
}

const REJECTED: [string, Row, string][] = [
  ['an 81-character name', { name: 'x'.repeat(81) }, 'name_chk'],
  ['an empty name', { name: '' }, 'name_chk'],
  [
    'a custom range of 93 days',
    { period: 'custom', custom_from: '2026-01-01', custom_to: '2026-04-04' },
    'custom_chk',
  ],
  [
    'a custom range ending before it starts',
    { period: 'custom', custom_from: '2026-02-01', custom_to: '2026-01-31' },
    'custom_chk',
  ],
  [
    'custom without custom_to',
    { period: 'custom', custom_from: '2026-07-01', custom_to: null },
    'custom_chk',
  ],
  [
    '11 recipients',
    { recipients: Array.from({ length: 11 }, (_, i) => `a${i}@x.test`) },
    'recipients_chk',
  ],
  ['weekly with a null weekday', { weekday: null }, 'schedule_chk'],
  [
    'monthly with a weekday',
    { cadence: 'monthly', weekday: 1 },
    'schedule_chk',
  ],
  [
    'a weekday with no cadence',
    { cadence: null, send_minute: null },
    'schedule_chk',
  ],
  ['a send_minute off the 15 minute step', { send_minute: 7 }, 'send_minute'],
  ['a send_minute of 1440', { send_minute: 1440 }, 'send_minute'],
  ['a weekday of 7', { weekday: 7 }, 'weekday_chk'],
  ['an unknown cadence', { cadence: 'daily' }, 'cadence_chk'],
  ['no channels', { channel_ids: [] }, 'channels_chk'],
  ['no sections', { sections: [] }, 'sections_chk'],
  ['an unknown period', { period: 'yesterday' }, 'period_chk'],
  ['an unknown compare', { compare: 'last_year' }, 'compare_chk'],
  ['an unknown chart metric', { chart_metric: 'likes' }, 'chart_metric_chk'],
  ['a 501-character note', { note: 'n'.repeat(501) }, 'note_chk'],
];

describeDb('insight_reports (database)', () => {
  it('stores a full weekly report and reads it back with its defaults', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { rows } = await insertReport(
        client,
        validRow(workspaceId, {
          period: 'custom',
          custom_from: '2026-07-01',
          custom_to: '2026-09-30',
          note: 'Hello',
          share_token: 'tok-1',
          send_to_team: true,
          recipients: ['a@x.test', 'b@x.test'],
          attach_pdf: false,
          next_run_at: '2026-11-16T04:00:00Z',
          created_by: ownerId,
          updated_by: ownerId,
        }),
      );

      const [r] = await db
        .select()
        .from(insightReports)
        .where(eq(insightReports.id, rows[0].id));
      expect(r.channelIds).toEqual([11, 12]);
      expect(r.sections).toEqual(['totals', 'chart']);
      expect(r.recipients).toEqual(['a@x.test', 'b@x.test']);
      expect(r.optedOut).toEqual([]);
      expect(r.customFrom).toBe('2026-07-01');
      expect(r.customTo).toBe('2026-09-30');
      expect(r.cadence).toBe('weekly');
      expect(r.weekday).toBe(1);
      expect(r.sendMinute).toBe(540);
      expect(r.sendToTeam).toBe(true);
      expect(r.attachPdf).toBe(false);
      expect(r.nextRunAt).toBeInstanceOf(Date);
      expect(r.nextRunAt?.toISOString()).toBe('2026-11-16T04:00:00.000Z');
      expect(r.createdAt).toBeInstanceOf(Date);
      expect(r.updatedAt).toBeInstanceOf(Date);
      expect(r.lastSentAt).toBeNull();
      expect(r.lastError).toBeNull();
      expect(r.logoMediaId).toBeNull();
    });
  });

  it('accepts a report with no schedule, a monthly one, and a 92-day custom range', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await insertReport(
        client,
        validRow(workspaceId, {
          cadence: null,
          weekday: null,
          send_minute: null,
        }),
      );
      await insertReport(
        client,
        validRow(workspaceId, { cadence: 'monthly', weekday: null }),
      );
      // 2026-01-01 .. 2026-04-02 is 92 days inclusive (custom_to - custom_from = 91).
      await insertReport(
        client,
        validRow(workspaceId, {
          period: 'custom',
          custom_from: '2026-01-01',
          custom_to: '2026-04-02',
        }),
      );
      const n = await client.query<{ n: number }>(
        `SELECT 1 FROM insight_reports WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(n.rows).toHaveLength(3);
    });
  });

  // A failed INSERT aborts the harness transaction, so each case gets its own.
  it.each(REJECTED)('rejects %s', async (_label, over, constraint) => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await expect(
        insertReport(client, validRow(workspaceId, over)),
      ).rejects.toThrow(
        new RegExp(`insight_reports_${constraint}|${constraint}`),
      );
    });
  });

  it('rejects a second report with the same share_token', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await insertReport(client, validRow(workspaceId, { share_token: 'dup' }));
      await expect(
        insertReport(client, validRow(workspaceId, { share_token: 'dup' })),
      ).rejects.toThrow(/share_token/);
    });
  });

  it('lets any number of reports have a null share_token', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await insertReport(client, validRow(workspaceId));
      await insertReport(client, validRow(workspaceId));
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM insight_reports
          WHERE workspace_id = $1 AND share_token IS NULL`,
        [workspaceId],
      );
      expect(n.rows[0].n).toBe(2);
    });
  });

  it('sets logo_media_id to null when the media item is deleted', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const mediaId = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      const { rows } = await insertReport(
        client,
        validRow(workspaceId, { logo_media_id: mediaId }),
      );
      await client.query(`DELETE FROM media_items WHERE id = $1`, [mediaId]);
      const after = await client.query(
        `SELECT logo_media_id FROM insight_reports WHERE id = $1`,
        [rows[0].id],
      );
      expect(after.rows).toEqual([{ logo_media_id: null }]);
    });
  });

  it('removes the reports of a deleted workspace', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await insertReport(client, validRow(workspaceId));
      await client.query(`DELETE FROM workspace WHERE id = $1`, [workspaceId]);
      const n = await client.query<{ n: number }>(
        `SELECT 1 FROM insight_reports WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(n.rows).toHaveLength(0);
    });
  });

  it('keeps the report and clears the author when the user is deleted', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ('author@example.test', 'Author')
         RETURNING id`,
      );
      const { rows } = await insertReport(
        client,
        validRow(workspaceId, { created_by: u.rows[0].id }),
      );
      await client.query(`DELETE FROM users WHERE id = $1`, [u.rows[0].id]);
      const after = await client.query(
        `SELECT created_by FROM insight_reports WHERE id = $1`,
        [rows[0].id],
      );
      expect(after.rows).toEqual([{ created_by: null }]);
    });
  });

  it('applies the file again as a no-op', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await insertReport(client, validRow(workspaceId));
      // The harness already ran the file twice; a third run must keep the row.
      const sql = readFileSync(
        join(process.cwd(), 'drizzle', 'migrations', MIGRATION),
        'utf8',
      );
      await expect(client.query(sql)).resolves.toBeDefined();
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM insight_reports`,
      );
      expect(n.rows[0].n).toBe(1);
    });
  });

  it('indexes the list read and the due scan', async () => {
    await withRollbackDb(MIGRATIONS, async (_db, client) => {
      const r = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'insight_reports'`,
      );
      const byName = Object.fromEntries(
        r.rows.map((x) => [x.indexname, x.indexdef]),
      );
      expect(byName['insight_reports_workspace_idx']).toMatch(
        /\(workspace_id, created_at DESC\)/,
      );
      expect(byName['insight_reports_due_idx']).toMatch(
        /\(next_run_at\) WHERE \(cadence IS NOT NULL\)/,
      );
    });
  });
});
