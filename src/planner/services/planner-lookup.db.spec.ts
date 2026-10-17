import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../testing/rollback-db';
import { PlannerLookupService } from './planner-lookup.service';

const MIGRATION = '0041_post_ready.sql';
const HOUR = 3600_000;

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

interface PostOpts {
  status?: string;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  createdAt?: string;
  channelIds?: string[];
}

async function post(
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  o: PostOpts,
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, scheduled_at, published_at, created_at, targets)
     VALUES ($1, $2, $3, 'x', $4::timestamptz, $5::timestamptz, COALESCE($6::timestamptz, now()), $7::jsonb) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      o.status ?? 'scheduled',
      o.scheduledAt ?? null,
      o.publishedAt ?? null,
      o.createdAt ?? null,
      JSON.stringify(
        (o.channelIds ?? []).map((channelId) => ({
          channelId,
          platform: 'twitter',
          status: 'scheduled',
        })),
      ),
    ],
  );
  return r.rows[0].id;
}

const counts = (r: { months: { month: number; count: number }[] }) =>
  r.months.map((m) => m.count);
const zeros = (n: number) => Array<number>(n).fill(0);

describeDb('PlannerLookupService', () => {
  const run = (
    fn: (svc: PlannerLookupService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      await fn(new PlannerLookupService(db), client);
    });

  describe('monthCounts', () => {
    const edge = '2026-12-31T23:30:00Z';

    it('buckets in the workspace zone: Auckland is January, UTC is December', () =>
      run(async (svc, client) => {
        const auckland = await workspace(client, 'a', 'Pacific/Auckland');
        const utc = await workspace(client, 'b', 'UTC');
        await post(client, auckland, { scheduledAt: edge });
        await post(client, utc, { scheduledAt: edge });

        expect(
          counts(await svc.monthCounts(auckland.workspaceId, 2026)),
        ).toEqual(zeros(12));
        expect(
          counts(await svc.monthCounts(auckland.workspaceId, 2027)),
        ).toEqual([1, ...zeros(11)]);
        expect(counts(await svc.monthCounts(utc.workspaceId, 2026))).toEqual([
          ...zeros(11),
          1,
        ]);
        expect(counts(await svc.monthCounts(utc.workspaceId, 2027))).toEqual(
          zeros(12),
        );
      }));

    it('treats an invalid stored zone as UTC', () =>
      run(async (svc, client) => {
        const w = await workspace(client, 'a', 'Mars/Olympus');
        await post(client, w, { scheduledAt: edge });
        expect(counts(await svc.monthCounts(w.workspaceId, 2026))).toEqual([
          ...zeros(11),
          1,
        ]);
      }));

    it('skips drafts and other workspaces; an empty workspace gives 12 numbered zeros', () =>
      run(async (svc, client) => {
        const w = await workspace(client, 'a');
        const other = await workspace(client, 'b');
        const empty = await svc.monthCounts(w.workspaceId, 2026);
        expect(empty.months.map((m) => m.month)).toEqual(
          Array.from({ length: 12 }, (_, i) => i + 1),
        );
        expect(counts(empty)).toEqual(zeros(12));

        await post(client, w, {
          status: 'draft',
          scheduledAt: '2026-03-10T10:00:00Z',
        });
        await post(client, other, { scheduledAt: '2026-03-10T10:00:00Z' });
        await post(client, w, { scheduledAt: '2026-03-10T10:00:00Z' });
        await post(client, w, {
          status: 'published',
          publishedAt: '2026-03-11T10:00:00Z',
        });
        // No time at all: nothing to place on a month.
        await post(client, w, { status: 'publishing' });
        const c = counts(await svc.monthCounts(w.workspaceId, 2026));
        expect(c[2]).toBe(2);
        expect(c.reduce((x, y) => x + y, 0)).toBe(2);
      }));
  });

  describe('nextPost', () => {
    it('ignores drafts and other workspaces, is strict, and returns null when nothing is later', () =>
      run(async (svc, client) => {
        const w = await workspace(client, 'a');
        const other = await workspace(client, 'b');
        const t = Date.now();
        const after = new Date(t);
        const iso = (ms: number) => new Date(ms).toISOString();
        await post(client, w, { status: 'draft', scheduledAt: iso(t + HOUR) });
        await post(client, other, { scheduledAt: iso(t + 2 * HOUR) });
        await expect(svc.nextPost(w.workspaceId, after)).resolves.toEqual({
          scheduledAt: null,
        });

        await post(client, w, { scheduledAt: iso(t) }); // not strictly after
        await post(client, w, { scheduledAt: iso(t + 5 * HOUR) });
        await post(client, w, { scheduledAt: iso(t + 3 * HOUR) });
        await expect(svc.nextPost(w.workspaceId, after)).resolves.toEqual({
          scheduledAt: iso(t + 3 * HOUR),
        });
      }));
  });

  describe('lastPostTime', () => {
    it('picks the newest created post on a listed channel; ignores drafts, other channels, other workspaces', () =>
      run(async (svc, client) => {
        const w = await workspace(client, 'a');
        const other = await workspace(client, 'b');
        await expect(svc.lastPostTime(w.workspaceId, [1, 2])).resolves.toEqual({
          at: null,
        });

        await post(client, w, {
          scheduledAt: '2026-05-01T09:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          channelIds: ['1'],
        });
        await post(client, w, {
          scheduledAt: '2026-05-02T09:00:00Z',
          createdAt: '2026-01-03T00:00:00Z',
          channelIds: ['2', '9'],
        });
        // Newer, but a draft / another channel / another workspace.
        await post(client, w, {
          status: 'draft',
          scheduledAt: '2026-05-03T09:00:00Z',
          createdAt: '2026-01-04T00:00:00Z',
          channelIds: ['1'],
        });
        await post(client, w, {
          scheduledAt: '2026-05-04T09:00:00Z',
          createdAt: '2026-01-05T00:00:00Z',
          channelIds: ['3'],
        });
        await post(client, other, {
          scheduledAt: '2026-05-05T09:00:00Z',
          createdAt: '2026-01-06T00:00:00Z',
          channelIds: ['1'],
        });
        await expect(svc.lastPostTime(w.workspaceId, [1, 2])).resolves.toEqual({
          at: '2026-05-02T09:00:00.000Z',
        });
        await expect(svc.lastPostTime(w.workspaceId, [1])).resolves.toEqual({
          at: '2026-05-01T09:00:00.000Z',
        });
        await expect(svc.lastPostTime(w.workspaceId, [77])).resolves.toEqual({
          at: null,
        });
      }));

    it('skips a timeless newest post and returns the older post instant', () =>
      run(async (svc, client) => {
        const w = await workspace(client, 'a');
        await post(client, w, {
          scheduledAt: '2026-05-01T09:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          channelIds: ['1'],
        });
        // Newest created, non-draft, but neither published_at nor scheduled_at.
        await post(client, w, {
          status: 'scheduled',
          createdAt: '2026-01-09T00:00:00Z',
          channelIds: ['1'],
        });
        await expect(svc.lastPostTime(w.workspaceId, [1])).resolves.toEqual({
          at: '2026-05-01T09:00:00.000Z',
        });
      }));
  });
});
