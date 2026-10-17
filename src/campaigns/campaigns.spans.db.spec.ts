import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import type { DbType } from '../drizzle/db';
import { CampaignsService } from './campaigns.service';
import type { CampaignPublishingService } from './campaign-publishing.service';
import type { EvergreenService } from './evergreen.service';

const NOW = new Date('2026-06-15T00:00:00.000Z');
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function workspace(client: PoolClient, tag: string, timezone = 'UTC') {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id, timezone) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      tag,
      `${tag}-${Math.random().toString(36).slice(2, 8)}`,
      u.rows[0].id,
      timezone,
    ],
  );
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

interface CampaignOpts {
  name: string;
  status?: string;
  start: string;
  end: string;
  tz?: string;
  time?: string;
}

async function campaign(
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  o: CampaignOpts,
) {
  const schedule = {
    type: 'bulk',
    startDate: o.start,
    endDate: o.end,
    defaultTime: o.time ?? '09:00',
    timezone: o.tz ?? 'UTC',
    blackoutDates: [],
    skipWeekends: false,
  };
  const r = await client.query<{ id: string }>(
    `INSERT INTO campaigns (workspace_id, created_by_id, name, type, status, schedule, channel_ids)
     VALUES ($1, $2, $3, 'bulk', $4, $5::jsonb, '["ch-1"]'::jsonb) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      o.name,
      o.status ?? 'active',
      JSON.stringify(schedule),
    ],
  );
  return r.rows[0].id;
}

const FILLED = JSON.stringify({
  mode: 'manual',
  postType: 'post',
  caption: 'hello',
  media: [],
  threadParts: [],
  templateIds: [],
});

async function slot(
  client: PoolClient,
  campaignId: string,
  date: string,
  slotStatus = 'pending',
  scheduledAt: string | null = null,
) {
  await client.query(
    `INSERT INTO campaign_slot_content (campaign_id, date, channel_id, time, content, slot_status, scheduled_at)
     VALUES ($1, $2, 'ch-1', '09:00', $3::jsonb, $4, $5::timestamptz)`,
    [campaignId, date, FILLED, slotStatus, scheduledAt],
  );
}

describeDb('CampaignsService.listSpans', () => {
  const run = (
    fn: (
      svc: CampaignsService,
      client: PoolClient,
      db: DbType,
    ) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      const svc = new CampaignsService(
        {} as CampaignPublishingService,
        {} as EvergreenService,
      );
      await fn(svc, client, db as unknown as DbType);
    });

  const names = (spans: { name: string }[]) => spans.map((s) => s.name);

  it('keeps campaigns overlapping the window, drops the rest', () =>
    run(async (svc, client, db) => {
      const w = await workspace(client, 'a');
      const other = await workspace(client, 'b');
      await campaign(client, w, {
        name: 'before',
        start: '2026-05-01',
        end: '2026-05-10',
      });
      await campaign(client, w, {
        name: 'spans-from',
        start: '2026-05-25',
        end: '2026-06-05',
      });
      await campaign(client, w, {
        name: 'inside',
        start: '2026-06-10',
        end: '2026-06-12',
      });
      await campaign(client, w, {
        name: 'after',
        start: '2026-08-01',
        end: '2026-08-05',
      });
      await campaign(client, w, {
        name: 'a-draft',
        status: 'draft',
        start: '2026-06-02',
        end: '2026-06-04',
      });
      await campaign(client, other, {
        name: 'other-workspace',
        start: '2026-06-02',
        end: '2026-06-04',
      });

      const spans = await svc.listSpans(
        w.workspaceId,
        utc('2026-06-01'),
        utc('2026-06-30'),
        NOW,
        db,
      );
      expect(names(spans)).toEqual(['spans-from', 'inside']);
      expect(spans[0]).toMatchObject({
        type: 'bulk',
        status: 'active',
        startDate: '2026-05-25',
        endDate: '2026-06-05',
        timezone: 'UTC',
        channelIds: ['ch-1'],
        cadence: { kind: 'daily', times: ['09:00'] },
      });
    }));

  it('postsPlanned and postsPublished equal computeMetrics', () =>
    run(async (svc, client, db) => {
      const w = await workspace(client, 'a');
      const id = await campaign(client, w, {
        name: 'metrics',
        start: '2026-06-10',
        end: '2026-06-14',
      });
      await slot(client, id, '2026-06-10', 'published');
      await slot(client, id, '2026-06-11', 'published');
      await slot(client, id, '2026-06-12', 'failed');
      await slot(client, id, '2026-06-13', 'pending');
      await slot(client, id, '2026-06-14', 'pending');
      await client.query(
        `INSERT INTO campaign_days (campaign_id, date, skip) VALUES ($1, '2026-06-14', true)`,
        [id],
      );

      const [span] = await svc.listSpans(
        w.workspaceId,
        utc('2026-06-01'),
        utc('2026-06-30'),
        NOW,
        db,
      );
      const days = await client.query(
        `SELECT date, skip FROM campaign_days WHERE campaign_id = $1`,
        [id],
      );
      const slots = await client.query(
        `SELECT date, content, slot_status AS "slotStatus" FROM campaign_slot_content WHERE campaign_id = $1`,
        [id],
      );
      const dto = svc.computeMetrics(days.rows, slots.rows);
      expect(span.postsPlanned).toBe(dto.postsPlanned);
      expect(span.postsPublished).toBe(dto.postsPublished);
      expect(span).toMatchObject({ postsPlanned: 4, postsPublished: 2 });
    }));

  it('a skipped day and a skipped slot shrink the span', () =>
    run(async (svc, client, db) => {
      const w = await workspace(client, 'a');
      const id = await campaign(client, w, {
        name: 'shrunk',
        start: '2026-06-10',
        end: '2026-06-20',
      });
      await slot(client, id, '2026-06-10');
      await slot(client, id, '2026-06-12');
      await slot(client, id, '2026-06-20', 'skipped');
      await client.query(
        `INSERT INTO campaign_days (campaign_id, date, skip) VALUES ($1, '2026-06-10', true)`,
        [id],
      );
      const [span] = await svc.listSpans(
        w.workspaceId,
        utc('2026-06-01'),
        utc('2026-06-30'),
        NOW,
        db,
      );
      expect(span).toMatchObject({
        startDate: '2026-06-12',
        endDate: '2026-06-12',
      });
    }));

  it('reports dates in the workspace zone, and survives an invalid zone', () =>
    run(async (svc, client, db) => {
      const auckland = await workspace(client, 'nz', 'Pacific/Auckland');
      const id = await campaign(client, auckland, {
        name: 'late',
        start: '2026-07-01',
        end: '2026-07-01',
        tz: 'Asia/Karachi',
        time: '23:30',
      });
      await slot(client, id, '2026-07-01');
      await client.query(
        `UPDATE campaign_slot_content SET time = '23:30' WHERE campaign_id = $1`,
        [id],
      );
      const [nz] = await svc.listSpans(
        auckland.workspaceId,
        utc('2026-06-01'),
        utc('2026-07-31'),
        NOW,
        db,
      );
      expect(nz).toMatchObject({ startDate: '2026-07-02' });

      const mars = await workspace(client, 'mars', 'Mars/Olympus');
      await campaign(client, mars, {
        name: 'mars',
        start: '2026-07-01',
        end: '2026-07-02',
      });
      const spans = await svc.listSpans(
        mars.workspaceId,
        utc('2026-06-01'),
        utc('2026-07-31'),
        NOW,
        db,
      );
      expect(names(spans)).toEqual(['mars']);
    }));

  it('runs a constant number of queries however many campaigns match', () =>
    run(async (svc, client, db) => {
      const w = await workspace(client, 'a');
      for (let i = 0; i < 5; i += 1) {
        const id = await campaign(client, w, {
          name: `c${i}`,
          start: '2026-06-10',
          end: '2026-06-14',
        });
        await slot(client, id, '2026-06-10');
      }
      const spy = jest.spyOn(client, 'query');
      const spans = await svc.listSpans(
        w.workspaceId,
        utc('2026-06-01'),
        utc('2026-06-30'),
        NOW,
        db,
      );
      expect(spans).toHaveLength(5);
      // workspace zone + campaigns + days + slots
      expect(spy).toHaveBeenCalledTimes(4);
      spy.mockRestore();
    }));
});
