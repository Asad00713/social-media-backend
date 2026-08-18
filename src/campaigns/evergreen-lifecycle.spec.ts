import { getTableName } from 'drizzle-orm';
import type { EvergreenService } from './evergreen.service';
import type { CampaignsService } from './campaigns.service';
import type {
  EvergreenCategory,
  EvergreenOccurrence,
  EvergreenPost,
} from '../drizzle/schema/evergreen.schema';
import type { Campaign } from '../drizzle/schema/campaigns.schema';

// ==========================================================================
// Fake-DB test harness — mirrors evergreen.service.spec.ts's
// `loadServiceWithFakeDb` / table-name-routed `buildFakeDb` pattern, extended
// with a `posts` table (needed for `pause`'s not-yet-published-post cleanup).
// ==========================================================================

function buildFakePublishing() {
  return {
    materializeAndEnqueue: jest.fn().mockResolvedValue({
      postId: 'materialized-post-1',
      jobId: 'materialized-job-1',
    }),
    cancelSlotJob: jest.fn().mockResolvedValue(undefined),
    buildJobId: jest.fn(),
  };
}

function buildFakeQueue() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'queue-job-1' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
}

/** Loads a fresh, isolated copy of `EvergreenService` with `../drizzle/db`
 *  mocked to `fakeDb`. */
function loadEvergreenServiceWithFakeDb(
  fakeDb: unknown,
  publishing: ReturnType<typeof buildFakePublishing> = buildFakePublishing(),
  queue: ReturnType<typeof buildFakeQueue> = buildFakeQueue(),
): InstanceType<typeof EvergreenService> {
  let Ctor!: typeof EvergreenService;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    Ctor = require('./evergreen.service').EvergreenService;
  });
  return new Ctor(publishing as never, queue as never);
}

/** Loads a fresh, isolated copy of `CampaignsService` with `../drizzle/db`
 *  mocked to `fakeDb`, wired with a real `EvergreenService` (also pointed at
 *  the same fake db) OR a jest.fn-mocked `EvergreenService` (for the
 *  regression guard, where we must assert non-invocation). */
function loadCampaignsServiceWithFakeDb(
  fakeDb: unknown,
  publishing: ReturnType<typeof buildFakePublishing> = buildFakePublishing(),
  evergreen: unknown = undefined,
): InstanceType<typeof CampaignsService> {
  let Ctor!: typeof CampaignsService;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    Ctor = require('./campaigns.service').CampaignsService;
  });
  return new Ctor(publishing as never, evergreen as never);
}

afterEach(() => {
  jest.dontMock('../drizzle/db');
  jest.resetModules();
});

const WORKSPACE_ID = 'ws-1';
const CAMPAIGN_ID = 'campaign-1';
const CATEGORY_ID = 'category-1';
const POST_ID = 'post-1';
const OCCURRENCE_ID = 'occurrence-1';

function makeCampaignRow(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    workspaceId: WORKSPACE_ID,
    createdById: 'user-1',
    name: 'Evergreen A',
    description: null,
    type: 'evergreen',
    status: 'draft',
    schedule: {
      type: 'evergreen',
      startDate: '2026-08-18',
      weekdays: [],
      times: [],
      timezone: 'UTC',
      blackoutDates: [],
      loop: true,
    },
    contentSource: 'manual',
    aiConfig: null,
    libraryTemplateIds: [],
    channelIds: [],
    platforms: [],
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    launchedAt: null,
    ...overrides,
  } as Campaign;
}

function makeCategoryRow(
  overrides: Partial<EvergreenCategory> = {},
): EvergreenCategory {
  return {
    id: CATEGORY_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Tips',
    color: 'emerald',
    schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    channelIds: ['12'],
    seasonal: null,
    isActive: true,
    rotationCursor: 0,
    sortOrder: 0,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as EvergreenCategory;
}

function makePostRow(overrides: Partial<EvergreenPost> = {}): EvergreenPost {
  return {
    id: POST_ID,
    campaignId: CAMPAIGN_ID,
    categoryId: CATEGORY_ID,
    content: {
      mode: 'manual',
      postType: 'text',
      caption: 'Hello world',
      media: [],
      threadParts: [],
      templateIds: [],
    },
    variations: [],
    recyclePolicy: { mode: 'forever' },
    minGapHours: 0,
    recycledCount: 0,
    lastPublishedAt: null,
    performanceScore: null,
    isStale: false,
    staleReason: null,
    status: 'active',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as EvergreenPost;
}

function makeOccurrenceRow(
  overrides: Partial<EvergreenOccurrence> = {},
): EvergreenOccurrence {
  return {
    id: OCCURRENCE_ID,
    campaignId: CAMPAIGN_ID,
    categoryId: CATEGORY_ID,
    postIdRef: POST_ID,
    variationId: null,
    channelId: '12',
    scheduledAt: new Date('2026-08-18T09:00:00Z'),
    slotStatus: 'scheduled',
    postsRowId: null,
    jobId: null,
    publishedAt: null,
    lastError: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as EvergreenOccurrence;
}

interface FakePostsRow {
  id: string;
  status: string;
}

function makeFakePostsRow(overrides: Partial<FakePostsRow> = {}): FakePostsRow {
  return { id: 'posts-row-1', status: 'scheduled', ...overrides };
}

interface FakeChannelRow {
  id: number;
  platform: string;
}

function makeChannelRow(
  overrides: Partial<FakeChannelRow> = {},
): FakeChannelRow {
  return { id: 12, platform: 'facebook', ...overrides };
}

/**
 * Table-name-routed, stateful fake db shared by both `EvergreenService` and
 * `CampaignsService` tests. SELECT always returns CLONES — never the same
 * reference the fixture holds — per the mandatory no-in-place-mutation
 * ruling (a prior effort's test harness masked a real bug by handing back
 * live references).
 */
function buildFakeDb(fixture: {
  campaignRows?: Campaign[];
  categoryRows?: EvergreenCategory[];
  postRows?: EvergreenPost[];
  occurrenceRows?: EvergreenOccurrence[];
  channelRows?: FakeChannelRow[];
  postsTableRows?: FakePostsRow[];
  // campaigns.schema tables — only needed for the bulk-campaign regression
  // guard (CampaignsService.launch reads campaignDays/campaignSlotContent).
  campaignDaysRows?: { id: string; campaignId: string; date: string; skip: boolean }[];
  campaignSlotContentRows?: Record<string, unknown>[];
}) {
  const campaignRows = fixture.campaignRows ?? [];
  const categoryRows = fixture.categoryRows ?? [];
  const postRows = fixture.postRows ?? [];
  const occurrenceRows = fixture.occurrenceRows ?? [];
  const channelRows = fixture.channelRows ?? [];
  const postsTableRows = fixture.postsTableRows ?? [];
  const campaignDaysRows = fixture.campaignDaysRows ?? [];
  const campaignSlotContentRows = fixture.campaignSlotContentRows ?? [];

  const inserts: {
    campaigns: unknown[];
    categories: unknown[];
    posts: unknown[];
    occurrences: unknown[];
    postsTable: unknown[];
  } = { campaigns: [], categories: [], posts: [], occurrences: [], postsTable: [] };
  const deletes: {
    categoryIds: string[];
    postIds: string[];
    postsTableIds: string[];
  } = {
    categoryIds: [],
    postIds: [],
    postsTableIds: [],
  };

  function tableRows(name: string): Record<string, unknown>[] {
    if (name === 'campaigns')
      return campaignRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_categories')
      return categoryRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_posts')
      return postRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_occurrences')
      return occurrenceRows as unknown as Record<string, unknown>[];
    if (name === 'social_media_channels')
      return channelRows as unknown as Record<string, unknown>[];
    if (name === 'posts')
      return postsTableRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_days')
      return campaignDaysRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_slot_content')
      return campaignSlotContentRows as unknown as Record<string, unknown>[];
    return [];
  }

  const db = {
    select: (_sel?: unknown) => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const rows = tableRows(name);

        const exec = (whereCond?: unknown) => {
          if (!whereCond) return Promise.resolve(rows.map((r) => ({ ...r })));
          const wanted = extractEqValues(whereCond);
          const filtered = rows.filter((r) => {
            if (wanted.id !== undefined && r.id !== wanted.id) return false;
            if (
              wanted.campaign_id !== undefined &&
              r.campaignId !== wanted.campaign_id
            )
              return false;
            if (
              wanted.category_id !== undefined &&
              r.categoryId !== wanted.category_id
            )
              return false;
            if (wanted.workspace_id !== undefined) {
              if (r.workspaceId !== wanted.workspace_id) return false;
            }
            if (wanted.status !== undefined && r.status !== wanted.status) {
              return false;
            }
            if (wanted.slot_status !== undefined) {
              if (r.slotStatus !== wanted.slot_status) return false;
            }
            if (wanted.channel_id !== undefined) {
              const wantedChannelId = wanted.channel_id as string | number;
              if (name === 'social_media_channels') {
                if (String(r.id) !== String(wantedChannelId)) return false;
              } else if (r.channelId !== wantedChannelId) {
                return false;
              }
            }
            return true;
          });
          // MANDATORY: clones, never fixture references.
          return Promise.resolve(filtered.map((r) => ({ ...r })));
        };

        return {
          where(whereCond: unknown) {
            return {
              orderBy: () => exec(whereCond),
              then: (
                resolve: (v: Record<string, unknown>[]) => void,
                reject: (e: unknown) => void,
              ) => exec(whereCond).then(resolve, reject),
            };
          },
          orderBy() {
            return exec();
          },
          then: (
            resolve: (v: Record<string, unknown>[]) => void,
            reject: (e: unknown) => void,
          ) => exec().then(resolve, reject),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
        const name = getTableName(table as never);
        const items = Array.isArray(vals) ? vals : [vals];
        const rowsOut: Record<string, unknown>[] = [];

        for (const item of items) {
          let row: Record<string, unknown> | undefined;
          if (name === 'campaigns') {
            row = {
              id: `campaign-new-${campaignRows.length + 1}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              launchedAt: null,
              ...item,
            };
            campaignRows.push(row as unknown as Campaign);
            inserts.campaigns.push(item);
          } else if (name === 'campaign_evergreen_categories') {
            row = {
              id: `cat-${categoryRows.length + 1}`,
              rotationCursor: 0,
              sortOrder: 0,
              seasonal: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...item,
            };
            categoryRows.push(row as unknown as EvergreenCategory);
            inserts.categories.push(item);
          } else if (name === 'campaign_evergreen_posts') {
            row = {
              id: `post-${postRows.length + 1}`,
              recycledCount: 0,
              lastPublishedAt: null,
              performanceScore: null,
              isStale: false,
              staleReason: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...item,
            };
            postRows.push(row as unknown as EvergreenPost);
            inserts.posts.push(item);
          } else if (name === 'campaign_evergreen_occurrences') {
            row = {
              id: `occ-${occurrenceRows.length + 1}`,
              variationId: null,
              slotStatus: 'scheduled',
              postsRowId: null,
              jobId: null,
              publishedAt: null,
              lastError: null,
              createdAt: new Date(),
              ...item,
            };
            occurrenceRows.push(row as unknown as EvergreenOccurrence);
            inserts.occurrences.push(item);
          } else if (name === 'posts') {
            row = {
              id: `posts-row-${postsTableRows.length + 1}`,
              status: 'scheduled',
              ...item,
            };
            postsTableRows.push(row as unknown as FakePostsRow);
            inserts.postsTable.push(item);
          }
          if (row) rowsOut.push(row);
        }

        const query = Promise.resolve(rowsOut) as Promise<
          Record<string, unknown>[]
        > & {
          returning: () => Promise<Record<string, unknown>[]>;
        };
        query.returning = () => Promise.resolve(rowsOut.map((r) => ({ ...r })));
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (whereCond: unknown) => {
          const name = getTableName(table as never);
          const wanted = extractEqValues(whereCond);
          const rows = tableRows(name);
          for (const row of rows) {
            if (wanted.id !== undefined && row.id !== wanted.id) continue;
            if (
              wanted.campaign_id !== undefined &&
              row.campaignId !== wanted.campaign_id
            )
              continue;
            Object.assign(row, set);
          }
          return Promise.resolve();
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (whereCond: unknown) => {
        const name = getTableName(table as never);
        const wanted = extractEqValues(whereCond);
        if (name === 'campaign_evergreen_categories') {
          const idx = categoryRows.findIndex((r) => r.id === wanted.id);
          if (idx !== -1) {
            deletes.categoryIds.push(categoryRows[idx].id);
            categoryRows.splice(idx, 1);
          }
        }
        if (name === 'campaign_evergreen_posts') {
          if (wanted.id !== undefined) {
            const idx = postRows.findIndex((r) => r.id === wanted.id);
            if (idx !== -1) {
              deletes.postIds.push(postRows[idx].id);
              postRows.splice(idx, 1);
            }
          } else if (wanted.category_id !== undefined) {
            for (let i = postRows.length - 1; i >= 0; i--) {
              if (postRows[i].categoryId === wanted.category_id) {
                deletes.postIds.push(postRows[i].id);
                postRows.splice(i, 1);
              }
            }
          }
        }
        if (name === 'campaign_evergreen_occurrences') {
          const idx = occurrenceRows.findIndex((r) => r.id === wanted.id);
          if (idx !== -1) occurrenceRows.splice(idx, 1);
        }
        if (name === 'posts') {
          // `pause` guards the delete on status='scheduled' — mirror that: a
          // delete whose where-clause includes status must only remove rows
          // matching BOTH id and status (returning 0 rows deleted otherwise).
          const idx = postsTableRows.findIndex((r) => {
            if (wanted.id !== undefined && r.id !== wanted.id) return false;
            if (wanted.status !== undefined && r.status !== wanted.status)
              return false;
            return true;
          });
          const deletedRows: Record<string, unknown>[] = [];
          if (idx !== -1) {
            deletedRows.push({ ...postsTableRows[idx] });
            deletes.postsTableIds.push(postsTableRows[idx].id);
            postsTableRows.splice(idx, 1);
          }
          const query = Promise.resolve(deletedRows) as Promise<
            Record<string, unknown>[]
          > & { returning: () => Promise<Record<string, unknown>[]> };
          query.returning = () => Promise.resolve(deletedRows);
          return query;
        }
        return Promise.resolve();
      },
    }),
  };

  return {
    db,
    inserts,
    deletes,
    campaignRows,
    categoryRows,
    postRows,
    occurrenceRows,
    channelRows,
    postsTableRows,
    campaignDaysRows,
    campaignSlotContentRows,
  };
}

/** Walk an `eq(col, v)` / `and(eq(colA, v1), eq(colB, v2))` drizzle condition
 *  tree into `{ dbColumnName: value }`. */
function extractEqValues(cond: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let pendingColumn: string | undefined;
  function walk(node: unknown): void {
    if (node == null || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const named = node as {
      name?: string;
      columnType?: string;
      value?: unknown;
    };
    if (
      typeof named.name === 'string' &&
      typeof named.columnType === 'string'
    ) {
      pendingColumn = named.name;
    } else if (
      pendingColumn &&
      named.value !== undefined &&
      typeof named.value !== 'object'
    ) {
      result[pendingColumn] = named.value;
      pendingColumn = undefined;
    }
  }
  walk(cond);
  return result;
}

// ==========================================================================
// EvergreenService.armCategory — multi-channel fan-out (folded in from T6
// review). A category with N channelIds must arm N occurrences (one per
// channel) at the SAME fire instant, sharing the picked post per instant.
// ==========================================================================

describe('EvergreenService.armCategory — multi-channel fan-out', () => {
  it('a category with 2 channelIds arms 2 occurrences at one fire, sharing the picked post', async () => {
    const category = makeCategoryRow({ channelIds: ['12', '34'] });
    const campaign = makeCampaignRow();
    const { db, inserts, occurrenceRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const queue = buildFakeQueue();
    const service = loadEvergreenServiceWithFakeDb(
      db,
      buildFakePublishing(),
      queue,
    );

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(2);
    const channelIdsArmed = occurrenceRows.map((o) => o.channelId).sort();
    expect(channelIdsArmed).toEqual(['12', '34']);

    // Same fire instant, same picked post, for both.
    expect(occurrenceRows[0].scheduledAt.getTime()).toBe(
      occurrenceRows[1].scheduledAt.getTime(),
    );
    expect(occurrenceRows[0].postIdRef).toBe(POST_ID);
    expect(occurrenceRows[1].postIdRef).toBe(POST_ID);

    // One BullMQ job per occurrence, deterministic non-colliding jobIds.
    expect(queue.add).toHaveBeenCalledTimes(2);
    const jobIds = (
      queue.add.mock.calls as unknown as [
        string,
        unknown,
        { jobId: string },
      ][]
    ).map(([, , opts]) => opts.jobId);
    expect(new Set(jobIds).size).toBe(2);
    expect(jobIds.sort()).toEqual(
      [`evg-${occurrenceRows[0].id}`, `evg-${occurrenceRows[1].id}`].sort(),
    );
  });

  it('single-channel category still arms exactly 1 occurrence (no regression)', async () => {
    const category = makeCategoryRow({ channelIds: ['12'] });
    const campaign = makeCampaignRow();
    const { db, inserts, occurrenceRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const queue = buildFakeQueue();
    const service = loadEvergreenServiceWithFakeDb(
      db,
      buildFakePublishing(),
      queue,
    );

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(1);
    expect(occurrenceRows[0].channelId).toBe('12');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('with no channelIds configured: arms nothing', async () => {
    const category = makeCategoryRow({ channelIds: [] });
    const campaign = makeCampaignRow();
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const queue = buildFakeQueue();
    const service = loadEvergreenServiceWithFakeDb(
      db,
      buildFakePublishing(),
      queue,
    );

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// EvergreenService.launch
// ==========================================================================

describe('EvergreenService.launch', () => {
  it('arms exactly one fire per active category (single channel) and sets status active + launchedAt', async () => {
    const category = makeCategoryRow({ isActive: true, channelIds: ['12'] });
    const campaign = makeCampaignRow({ status: 'draft' });
    const { db, inserts, campaignRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    const dto = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(inserts.occurrences).toHaveLength(1);
    expect(campaignRows[0].status).toBe('active');
    expect(campaignRows[0].launchedAt).not.toBeNull();
    expect(dto.status).toBe('active');
  });

  it('fans out across multiple active categories, each per their own channelIds', async () => {
    const categoryA = makeCategoryRow({
      id: 'category-a',
      channelIds: ['12', '34'],
    });
    const categoryB = makeCategoryRow({
      id: 'category-b',
      name: 'Category B',
      channelIds: ['56'],
    });
    const campaign = makeCampaignRow();
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [categoryA, categoryB],
      postRows: [
        makePostRow({ id: 'post-a', categoryId: 'category-a' }),
        makePostRow({ id: 'post-b', categoryId: 'category-b' }),
      ],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    // categoryA fans out to 2 (channels 12+34), categoryB to 1 (channel 56).
    expect(inserts.occurrences).toHaveLength(3);
  });

  it('a category with 0 eligible posts arms nothing for that category but the campaign still launches', async () => {
    const categoryWithPosts = makeCategoryRow({
      id: 'category-a',
      channelIds: ['12'],
    });
    const categoryEmpty = makeCategoryRow({
      id: 'category-b',
      name: 'Empty',
      channelIds: ['34'],
    });
    const campaign = makeCampaignRow();
    const { db, inserts, campaignRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [categoryWithPosts, categoryEmpty],
      postRows: [makePostRow({ id: 'post-a', categoryId: 'category-a' })],
      // category-b has NO posts in the pool -> nothing eligible to arm.
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    const dto = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(inserts.occurrences).toHaveLength(1); // only category-a armed
    expect(campaignRows[0].status).toBe('active'); // launch still succeeds
    expect(dto.status).toBe('active');
  });

  it('throws when there is no active category with at least one eligible post', async () => {
    const inactiveCategory = makeCategoryRow({ isActive: false });
    const campaign = makeCampaignRow();
    const { db } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [inactiveCategory],
      postRows: [makePostRow()],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow();
  });

  it('throws when the only active category has zero pool posts', async () => {
    const category = makeCategoryRow({ isActive: true });
    const campaign = makeCampaignRow();
    const { db } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow();
  });
});

// ==========================================================================
// EvergreenService.pause
// ==========================================================================

describe('EvergreenService.pause', () => {
  it('cancels every future scheduled occurrence job + deletes its unpublished posts row, and sets status paused', async () => {
    const category = makeCategoryRow();
    const campaign = makeCampaignRow({ status: 'active' });
    const scheduledOccurrence = makeOccurrenceRow({
      slotStatus: 'scheduled',
      jobId: 'evg-occurrence-1',
      postsRowId: 'posts-row-1',
      scheduledAt: new Date('2099-01-01T09:00:00Z'), // future
    });
    const publishedOccurrence = makeOccurrenceRow({
      id: 'occurrence-2',
      slotStatus: 'published',
      jobId: null,
      postsRowId: 'posts-row-2',
      scheduledAt: new Date('2020-01-01T09:00:00Z'), // past, already fired
    });
    const { db, campaignRows, occurrenceRows, postsTableRows, deletes } =
      buildFakeDb({
        campaignRows: [campaign],
        categoryRows: [category],
        postRows: [makePostRow()],
        occurrenceRows: [scheduledOccurrence, publishedOccurrence],
        postsTableRows: [
          makeFakePostsRow({ id: 'posts-row-1', status: 'scheduled' }),
          makeFakePostsRow({ id: 'posts-row-2', status: 'published' }),
        ],
      });
    const publishing = buildFakePublishing();
    const service = loadEvergreenServiceWithFakeDb(db, publishing);

    const dto = await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

    expect(publishing.cancelSlotJob).toHaveBeenCalledWith('evg-occurrence-1');
    expect(publishing.cancelSlotJob).toHaveBeenCalledTimes(1); // NOT the published one

    // The scheduled slot's post row (still 'scheduled') got deleted.
    expect(deletes.postsTableIds).toContain('posts-row-1');
    expect(postsTableRows.map((r) => r.id)).not.toContain('posts-row-1');
    // The published slot's post row is untouched.
    expect(postsTableRows.map((r) => r.id)).toContain('posts-row-2');

    // Only the scheduled occurrence was touched (removed or its slotStatus
    // flipped away from scheduled) — verify it's no longer a live scheduled
    // occurrence, while the published one is untouched.
    const stillScheduled = occurrenceRows.some(
      (o) => o.id === 'occurrence-1' && o.slotStatus === 'scheduled',
    );
    expect(stillScheduled).toBe(false);
    expect(
      occurrenceRows.find((o) => o.id === 'occurrence-2')?.slotStatus,
    ).toBe('published');

    expect(campaignRows[0].status).toBe('paused');
    expect(dto.status).toBe('paused');
  });

  it('is a no-op on occurrences when there are none scheduled', async () => {
    const category = makeCategoryRow();
    const campaign = makeCampaignRow({ status: 'active' });
    const { db, campaignRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
      occurrenceRows: [],
    });
    const publishing = buildFakePublishing();
    const service = loadEvergreenServiceWithFakeDb(db, publishing);

    const dto = await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

    expect(publishing.cancelSlotJob).not.toHaveBeenCalled();
    expect(campaignRows[0].status).toBe('paused');
    expect(dto.status).toBe('paused');
  });
});

// ==========================================================================
// EvergreenService.resume
// ==========================================================================

describe('EvergreenService.resume', () => {
  it('re-arms every active category and sets status active', async () => {
    const activeCategory = makeCategoryRow({ isActive: true, channelIds: ['12'] });
    const inactiveCategory = makeCategoryRow({
      id: 'category-b',
      isActive: false,
      channelIds: ['34'],
    });
    const campaign = makeCampaignRow({ status: 'paused' });
    const { db, inserts, campaignRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [activeCategory, inactiveCategory],
      postRows: [
        makePostRow({ id: 'post-a', categoryId: CATEGORY_ID }),
        makePostRow({ id: 'post-b', categoryId: 'category-b' }),
      ],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    const dto = await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

    // Only the active category gets re-armed.
    expect(inserts.occurrences).toHaveLength(1);
    expect((inserts.occurrences[0] as { categoryId: string }).categoryId).toBe(
      CATEGORY_ID,
    );

    expect(campaignRows[0].status).toBe('active');
    expect(dto.status).toBe('active');
  });

  it('fans out multi-channel categories on resume too', async () => {
    const category = makeCategoryRow({ isActive: true, channelIds: ['12', '34'] });
    const campaign = makeCampaignRow({ status: 'paused' });
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

    expect(inserts.occurrences).toHaveLength(2);
  });
});

// ==========================================================================
// EvergreenService.reconcile
// ==========================================================================

describe('EvergreenService.reconcile', () => {
  it('re-arms a category whose only occurrence is already published (dead chain)', async () => {
    const category = makeCategoryRow({ isActive: true, channelIds: ['12'] });
    const campaign = makeCampaignRow({ status: 'active' });
    const deadOccurrence = makeOccurrenceRow({
      slotStatus: 'published',
      scheduledAt: new Date('2020-01-01T09:00:00Z'),
    });
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
      occurrenceRows: [deadOccurrence],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.reconcile();

    expect(inserts.occurrences).toHaveLength(1); // re-armed
  });

  it('is a no-op when a future scheduled occurrence already exists for the channel', async () => {
    const category = makeCategoryRow({ isActive: true, channelIds: ['12'] });
    const campaign = makeCampaignRow({ status: 'active' });
    const liveOccurrence = makeOccurrenceRow({
      slotStatus: 'scheduled',
      channelId: '12',
      scheduledAt: new Date('2099-01-01T09:00:00Z'),
    });
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
      occurrenceRows: [liveOccurrence],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.reconcile();

    expect(inserts.occurrences).toHaveLength(0); // untouched — already armed
  });

  it('re-arms per-channel: 2-channel category with only 1 channel covered gets the missing channel armed', async () => {
    const category = makeCategoryRow({
      isActive: true,
      channelIds: ['12', '34'],
    });
    const campaign = makeCampaignRow({ status: 'active' });
    // Only channel 12 has a live future occurrence; 34 has none.
    const liveOccurrence = makeOccurrenceRow({
      slotStatus: 'scheduled',
      channelId: '12',
      scheduledAt: new Date('2099-01-01T09:00:00Z'),
    });
    const { db, inserts, occurrenceRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
      occurrenceRows: [liveOccurrence],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.reconcile();

    // armCategory fans out to BOTH channels again in the current
    // (simple, idempotent-by-deterministic-jobId) implementation OR just
    // the missing one — either way channel 34 must end up armed.
    const channel34Armed = occurrenceRows.some(
      (o) => o.channelId === '34' && o.slotStatus === 'scheduled',
    );
    expect(channel34Armed).toBe(true);
    expect(inserts.occurrences.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores paused/draft campaigns and inactive categories', async () => {
    const activeCatOnPausedCampaign = makeCategoryRow({ isActive: true });
    const pausedCampaign = makeCampaignRow({
      id: 'campaign-paused',
      status: 'paused',
    });
    const inactiveCatOnActiveCampaign = makeCategoryRow({
      id: 'category-inactive',
      campaignId: 'campaign-active',
      isActive: false,
    });
    const activeCampaign = makeCampaignRow({
      id: 'campaign-active',
      status: 'active',
    });
    const { db, inserts } = buildFakeDb({
      campaignRows: [pausedCampaign, activeCampaign],
      categoryRows: [
        { ...activeCatOnPausedCampaign, campaignId: 'campaign-paused' },
        inactiveCatOnActiveCampaign,
      ],
      postRows: [
        makePostRow({ id: 'post-1', categoryId: CATEGORY_ID }),
        makePostRow({ id: 'post-2', categoryId: 'category-inactive' }),
      ],
    });
    const service = loadEvergreenServiceWithFakeDb(db);

    await service.reconcile();

    expect(inserts.occurrences).toHaveLength(0);
  });
});

// ==========================================================================
// CampaignsService delegation — evergreen campaigns route through
// EvergreenService; bulk/drip stays on the original path (byte-for-byte
// unchanged — asserted directly below).
// ==========================================================================

describe('CampaignsService lifecycle delegation to EvergreenService', () => {
  it('launch delegates to EvergreenService.launch for an evergreen campaign', async () => {
    const campaign = makeCampaignRow({ type: 'evergreen', status: 'draft' });
    const { db } = buildFakeDb({ campaignRows: [campaign] });
    const fakeEvergreen = {
      launch: jest.fn().mockResolvedValue({ id: CAMPAIGN_ID, status: 'active' }),
      pause: jest.fn(),
      resume: jest.fn(),
    };
    const service = loadCampaignsServiceWithFakeDb(
      db,
      buildFakePublishing(),
      fakeEvergreen,
    );

    const result = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(fakeEvergreen.launch).toHaveBeenCalledWith(WORKSPACE_ID, CAMPAIGN_ID);
    expect(result).toEqual({ id: CAMPAIGN_ID, status: 'active' });
  });

  it('pause delegates to EvergreenService.pause for an evergreen campaign', async () => {
    const campaign = makeCampaignRow({ type: 'evergreen', status: 'active' });
    const { db } = buildFakeDb({ campaignRows: [campaign] });
    const fakeEvergreen = {
      launch: jest.fn(),
      pause: jest.fn().mockResolvedValue({ id: CAMPAIGN_ID, status: 'paused' }),
      resume: jest.fn(),
    };
    const service = loadCampaignsServiceWithFakeDb(
      db,
      buildFakePublishing(),
      fakeEvergreen,
    );

    const result = await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

    expect(fakeEvergreen.pause).toHaveBeenCalledWith(WORKSPACE_ID, CAMPAIGN_ID);
    expect(result).toEqual({ id: CAMPAIGN_ID, status: 'paused' });
  });

  it('resume delegates to EvergreenService.resume for an evergreen campaign', async () => {
    const campaign = makeCampaignRow({ type: 'evergreen', status: 'paused' });
    const { db } = buildFakeDb({ campaignRows: [campaign] });
    const fakeEvergreen = {
      launch: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn().mockResolvedValue({ id: CAMPAIGN_ID, status: 'active' }),
    };
    const service = loadCampaignsServiceWithFakeDb(
      db,
      buildFakePublishing(),
      fakeEvergreen,
    );

    const result = await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

    expect(fakeEvergreen.resume).toHaveBeenCalledWith(WORKSPACE_ID, CAMPAIGN_ID);
    expect(result).toEqual({ id: CAMPAIGN_ID, status: 'active' });
  });

  // ------------------------------------------------------------------------
  // MANDATORY regression guard: a bulk campaign's launch must NEVER touch
  // EvergreenService, proving the bulk/drip path is byte-for-byte unchanged.
  // ------------------------------------------------------------------------
  it('REGRESSION GUARD: launch for a bulk campaign does NOT call any EvergreenService method', async () => {
    const bulkCampaign = makeCampaignRow({
      type: 'bulk',
      status: 'draft',
      schedule: {
        type: 'bulk',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
        defaultTime: '09:00',
        timezone: 'UTC',
        blackoutDates: [],
        skipWeekends: false,
      },
    });
    const filledSlot = {
      id: 'slot-1',
      campaignId: CAMPAIGN_ID,
      date: '2026-09-01',
      channelId: 'channel-1',
      time: '09:00',
      content: {
        mode: 'manual',
        postType: 'text',
        caption: 'Hello world',
        media: [],
        threadParts: [],
        templateIds: [],
      },
      slotStatus: 'pending',
      postId: null,
      jobId: null,
      scheduledAt: null,
      updatedAt: new Date(),
    };
    const { db } = buildFakeDb({
      campaignRows: [bulkCampaign],
      campaignDaysRows: [],
      campaignSlotContentRows: [filledSlot],
    });
    const fakeEvergreen = {
      launch: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
    };
    const service = loadCampaignsServiceWithFakeDb(
      db,
      buildFakePublishing(),
      fakeEvergreen,
    );

    const result = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(fakeEvergreen.launch).not.toHaveBeenCalled();
    expect(fakeEvergreen.pause).not.toHaveBeenCalled();
    expect(fakeEvergreen.resume).not.toHaveBeenCalled();
    // Bulk path ran its normal logic (not a stubbed-out branch).
    expect(result.status).toBe('active');
    expect(result.type).toBe('bulk');
  });
});
