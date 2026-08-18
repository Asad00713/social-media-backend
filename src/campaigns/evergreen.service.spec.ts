import { getTableName } from 'drizzle-orm';
import type { EvergreenService } from './evergreen.service';
import type {
  EvergreenCategory,
  EvergreenOccurrence,
  EvergreenPost,
} from '../drizzle/schema/evergreen.schema';
import type { Campaign } from '../drizzle/schema/campaigns.schema';

// ==========================================================================
// Fake-DB test harness — mirrors campaigns.service.spec.ts's
// `loadServiceWithFakeDb` / table-name-routed `buildFakeDb` pattern exactly.
// ==========================================================================

/** Minimal fake `CampaignPublishingService` — jest.fn mocks, no real DB/queue. */
function buildFakePublishing() {
  return {
    materializeAndEnqueue: jest.fn().mockResolvedValue({
      postId: 'materialized-post-1',
      jobId: 'materialized-job-1',
    }),
    cancelSlotJob: jest.fn().mockResolvedValue(undefined),
  };
}

/** Minimal fake BullMQ `Queue` — jest.fn mocks, no real Redis. */
function buildFakeQueue() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'queue-job-1' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Loads a fresh, isolated copy of the service module with `../drizzle/db`
 * mocked to `fakeDb`. `jest.isolateModules` scopes the mock + require to
 * this call only, so tests don't leak mocks between each other.
 */
function loadServiceWithFakeDb(
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

afterEach(() => {
  jest.dontMock('../drizzle/db');
  jest.resetModules();
});

const WORKSPACE_ID = 'ws-1';
const CAMPAIGN_ID = 'campaign-1';
const CATEGORY_ID = 'category-1';
const POST_ID = 'post-1';

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
    schedule: { weekdays: [1, 3], times: ['09:00'] },
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

const OCCURRENCE_ID = 'occurrence-1';

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
 * Table-name-routed, stateful fake db. Selects filter the in-memory fixture
 * arrays by campaignId/categoryId where relevant (good enough for this
 * service's simple equality-only where-clauses); updates/deletes/inserts
 * write through to the live fixture so a later select in the same call sees
 * the new state. SELECT always returns CLONES — never the same reference the
 * fixture holds — per the mandatory no-in-place-mutation ruling.
 */
function buildFakeDb(fixture: {
  campaignRows?: Campaign[];
  categoryRows?: EvergreenCategory[];
  postRows?: EvergreenPost[];
  occurrenceRows?: EvergreenOccurrence[];
  channelRows?: FakeChannelRow[];
}) {
  const campaignRows = fixture.campaignRows ?? [];
  const categoryRows = fixture.categoryRows ?? [];
  const postRows = fixture.postRows ?? [];
  const occurrenceRows = fixture.occurrenceRows ?? [];
  const channelRows = fixture.channelRows ?? [];

  const inserts: {
    campaigns: unknown[];
    categories: unknown[];
    posts: unknown[];
    occurrences: unknown[];
  } = { campaigns: [], categories: [], posts: [], occurrences: [] };
  const deletes: { categoryIds: string[]; postIds: string[] } = {
    categoryIds: [],
    postIds: [],
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
    return [];
  }

  const db = {
    select: (_sel?: unknown) => ({
      from: (table: unknown) => ({
        where: (whereCond: unknown) => {
          const name = getTableName(table as never);
          const rows = tableRows(name);
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
            if (wanted.channel_id !== undefined) {
              // channels table: numeric `id`. occurrences table: varchar `channelId`.
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
        },
      }),
    }),
    insert: (table: unknown) => ({
      // Performs the write immediately (matching real drizzle: `.values()`
      // itself is the awaitable query — `.returning()` is optional chaining
      // on top of it, not a separate execution step). Returning a thenable
      // object with both `.then()` (direct await) and `.returning()` covers
      // both call styles the service uses.
      values: (vals: Record<string, unknown>) => {
        const name = getTableName(table as never);
        let row: Record<string, unknown> | undefined;
        if (name === 'campaigns') {
          row = {
            id: `campaign-new-${campaignRows.length + 1}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            launchedAt: null,
            ...vals,
          };
          campaignRows.push(row as unknown as Campaign);
          inserts.campaigns.push(vals);
        } else if (name === 'campaign_evergreen_categories') {
          row = {
            id: `cat-${categoryRows.length + 1}`,
            rotationCursor: 0,
            sortOrder: 0,
            seasonal: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...vals,
          };
          categoryRows.push(row as unknown as EvergreenCategory);
          inserts.categories.push(vals);
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
            ...vals,
          };
          postRows.push(row as unknown as EvergreenPost);
          inserts.posts.push(vals);
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
            ...vals,
          };
          occurrenceRows.push(row as unknown as EvergreenOccurrence);
          inserts.occurrences.push(vals);
        }

        const resultRows = row ? [{ ...row }] : [];
        const query = Promise.resolve(resultRows) as Promise<unknown[]> & {
          returning: () => Promise<unknown[]>;
        };
        query.returning = () => Promise.resolve(resultRows);
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (whereCond: unknown) => {
          const name = getTableName(table as never);
          const wanted = extractEqValues(whereCond);
          const rows = tableRows(name);
          const row = rows.find((r) => r.id === wanted.id);
          if (row) Object.assign(row, set);
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
            // Bulk delete-by-category (the removeCategory cascade path) —
            // no `id` in the where clause, only `categoryId`.
            for (let i = postRows.length - 1; i >= 0; i--) {
              if (postRows[i].categoryId === wanted.category_id) {
                deletes.postIds.push(postRows[i].id);
                postRows.splice(i, 1);
              }
            }
          }
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
// Tests
// ==========================================================================

describe('EvergreenService.createCampaign', () => {
  it("inserts a campaigns row with type='evergreen', status='draft', and an evergreen schedule", async () => {
    const { db, inserts } = buildFakeDb({});
    const service = loadServiceWithFakeDb(db);

    const dto = await service.createCampaign(WORKSPACE_ID, 'user-1', {
      name: 'Evergreen A',
      startDate: '2026-08-18',
      timezone: 'UTC',
      channelIds: ['12'],
    });

    expect(inserts.campaigns).toHaveLength(1);
    const inserted = inserts.campaigns[0] as {
      type: string;
      status: string;
      schedule: {
        type: string;
        weekdays: number[];
        times: string[];
        loop: boolean;
      };
      channelIds: string[];
    };
    expect(inserted.type).toBe('evergreen');
    expect(inserted.status).toBe('draft');
    expect(inserted.schedule.type).toBe('evergreen');
    expect(inserted.schedule.weekdays).toEqual([]);
    expect(inserted.schedule.times).toEqual([]);
    expect(inserted.schedule.loop).toBe(true);
    expect(inserted.channelIds).toEqual(['12']);

    expect(dto.type).toBe('evergreen');
    expect(dto.status).toBe('draft');
    expect(dto.categories).toEqual([]);
    expect(dto.upNext).toEqual([]);
  });

  it('defaults loop to true and blackoutDates to [] when omitted', async () => {
    const { db, inserts } = buildFakeDb({});
    const service = loadServiceWithFakeDb(db);

    await service.createCampaign(WORKSPACE_ID, 'user-1', {
      name: 'Evergreen B',
      startDate: '2026-08-18',
      timezone: 'UTC',
      channelIds: [],
    });

    const inserted = inserts.campaigns[0] as {
      schedule: { loop: boolean; blackoutDates: string[] };
    };
    expect(inserted.schedule.loop).toBe(true);
    expect(inserted.schedule.blackoutDates).toEqual([]);
  });

  it('respects an explicit loop:false and blackoutDates', async () => {
    const { db, inserts } = buildFakeDb({});
    const service = loadServiceWithFakeDb(db);

    await service.createCampaign(WORKSPACE_ID, 'user-1', {
      name: 'Evergreen C',
      startDate: '2026-08-18',
      timezone: 'UTC',
      channelIds: [],
      loop: false,
      blackoutDates: ['2026-12-25'],
    });

    const inserted = inserts.campaigns[0] as {
      schedule: { loop: boolean; blackoutDates: string[] };
    };
    expect(inserted.schedule.loop).toBe(false);
    expect(inserted.schedule.blackoutDates).toEqual(['2026-12-25']);
  });
});

describe('EvergreenService.addCategory', () => {
  it('persists a category row and returns the assembled campaign with the new category', async () => {
    const { db, inserts } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.addCategory(WORKSPACE_ID, CAMPAIGN_ID, {
      name: 'Tips',
      color: 'emerald',
      schedule: { weekdays: [1, 3], times: ['09:00'] },
      channelIds: ['12'],
    });

    expect(inserts.categories).toHaveLength(1);
    const inserted = inserts.categories[0] as {
      campaignId: string;
      name: string;
    };
    expect(inserted.campaignId).toBe(CAMPAIGN_ID);
    expect(inserted.name).toBe('Tips');

    expect(dto.categories).toHaveLength(1);
    expect(dto.categories[0].name).toBe('Tips');
    expect(dto.categories[0].posts).toEqual([]);
  });
});

describe('EvergreenService.updateCategory', () => {
  it('patches the category fields and returns the assembled campaign', async () => {
    const { db } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.updateCategory(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      {
        name: 'Tips & Tricks',
      },
    );

    expect(dto.categories[0].name).toBe('Tips & Tricks');
  });
});

describe('EvergreenService.setCategoryActive', () => {
  it('flips isActive and returns the assembled campaign', async () => {
    const { db } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow({ isActive: true })],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.setCategoryActive(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      false,
    );

    expect(dto.categories[0].isActive).toBe(false);
  });
});

describe('EvergreenService.removeCategory', () => {
  it('cascades: removes the category and its posts', async () => {
    const { db, deletes, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [makePostRow(), makePostRow({ id: 'post-2' })],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.removeCategory(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
    );

    expect(deletes.categoryIds).toContain(CATEGORY_ID);
    expect(deletes.postIds.sort()).toEqual(['post-1', 'post-2']);
    expect(postRows).toHaveLength(0);
    expect(dto.categories).toEqual([]);
  });
});

describe('EvergreenService.addPost', () => {
  it('defaults recyclePolicy to {mode: "forever"} when omitted', async () => {
    const { db, inserts } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.addPost(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, {
      content: {
        mode: 'manual',
        postType: 'text',
        caption: 'Hello',
        media: [],
        threadParts: [],
        templateIds: [],
      },
    });

    expect(inserts.posts).toHaveLength(1);
    const inserted = inserts.posts[0] as {
      recyclePolicy: { mode: string };
      variations: unknown[];
      status: string;
    };
    expect(inserted.recyclePolicy).toEqual({ mode: 'forever' });
    expect(inserted.variations).toEqual([]);
    expect(inserted.status).toBe('active');

    expect(dto.categories[0].posts).toHaveLength(1);
    expect(dto.categories[0].posts[0].recyclePolicy).toEqual({
      mode: 'forever',
    });
  });

  it('respects an explicit recyclePolicy', async () => {
    const { db, inserts } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
    });
    const service = loadServiceWithFakeDb(db);

    await service.addPost(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, {
      content: {
        mode: 'manual',
        postType: 'text',
        caption: 'Hello',
        media: [],
        threadParts: [],
        templateIds: [],
      },
      recyclePolicy: { mode: 'maxCount', maxCount: 5 },
    });

    const inserted = inserts.posts[0] as {
      recyclePolicy: { mode: string; maxCount?: number };
    };
    expect(inserted.recyclePolicy).toEqual({ mode: 'maxCount', maxCount: 5 });
  });
});

describe('EvergreenService.updatePost', () => {
  it('patches the post fields and returns the assembled campaign', async () => {
    const { db } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [makePostRow()],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.updatePost(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      POST_ID,
      {
        minGapHours: 12,
      },
    );

    expect(dto.categories[0].posts[0].minGapHours).toBe(12);
  });
});

describe('EvergreenService.removePost', () => {
  it('removes the post row', async () => {
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [makePostRow(), makePostRow({ id: 'post-2' })],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.removePost(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      POST_ID,
    );

    expect(postRows.map((p) => p.id)).toEqual(['post-2']);
    expect(dto.categories[0].posts).toHaveLength(1);
    expect(dto.categories[0].posts[0].id).toBe('post-2');
  });
});

describe('EvergreenService.assembleEvergreen', () => {
  it('computes each category nextRunAt via computeNextCategoryFire and returns upNext: []', async () => {
    const campaignRow = makeCampaignRow({
      schedule: {
        type: 'evergreen',
        startDate: '2026-08-18',
        weekdays: [],
        times: [],
        timezone: 'UTC',
        blackoutDates: [],
        loop: true,
      },
    });
    const categoryRow = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const { db } = buildFakeDb({
      campaignRows: [campaignRow],
      categoryRows: [categoryRow],
      postRows: [makePostRow()],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.assembleEvergreen(CAMPAIGN_ID);

    expect(dto.id).toBe(CAMPAIGN_ID);
    expect(dto.categories).toHaveLength(1);
    expect(dto.categories[0].id).toBe(CATEGORY_ID);
    expect(dto.categories[0].posts).toHaveLength(1);
    expect(dto.categories[0].nextRunAt).not.toBeNull();
    // Mon/Wed/Fri 09:00 UTC after 'now' — just assert it parses to a real date.
    expect(
      new Date(dto.categories[0].nextRunAt as string).getTime(),
    ).not.toBeNaN();
    expect(dto.upNext).toEqual([]);
  });

  it('returns nextRunAt: null for a category with no weekdays/times configured', async () => {
    const campaignRow = makeCampaignRow();
    const categoryRow = makeCategoryRow({
      schedule: { weekdays: [], times: [] },
    });
    const { db } = buildFakeDb({
      campaignRows: [campaignRow],
      categoryRows: [categoryRow],
      postRows: [],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.assembleEvergreen(CAMPAIGN_ID);

    expect(dto.categories[0].nextRunAt).toBeNull();
  });

  it('throws NotFoundException when the campaign does not exist', async () => {
    const { db } = buildFakeDb({});
    const service = loadServiceWithFakeDb(db);

    await expect(service.assembleEvergreen('missing-id')).rejects.toThrow(
      'Campaign not found',
    );
  });

  it('fills upNext from scheduled evergreenOccurrences, ordered by scheduledAt asc', async () => {
    const campaignRow = makeCampaignRow();
    const categoryRow = makeCategoryRow({
      schedule: { weekdays: [], times: [] },
    });
    const laterOccurrence = makeOccurrenceRow({
      id: 'occ-later',
      scheduledAt: new Date('2026-08-20T09:00:00Z'),
    });
    const soonerOccurrence = makeOccurrenceRow({
      id: 'occ-sooner',
      scheduledAt: new Date('2026-08-19T09:00:00Z'),
    });
    const pastOccurrence = makeOccurrenceRow({
      id: 'occ-past',
      scheduledAt: new Date('2020-01-01T09:00:00Z'),
    });
    const publishedOccurrence = makeOccurrenceRow({
      id: 'occ-published',
      scheduledAt: new Date('2026-08-21T09:00:00Z'),
      slotStatus: 'published',
    });
    const { db } = buildFakeDb({
      campaignRows: [campaignRow],
      categoryRows: [categoryRow],
      postRows: [],
      occurrenceRows: [
        laterOccurrence,
        soonerOccurrence,
        pastOccurrence,
        publishedOccurrence,
      ],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.assembleEvergreen(CAMPAIGN_ID);

    expect(dto.upNext).toHaveLength(2);
    expect(dto.upNext[0]).toMatchObject({ occurrenceId: 'occ-sooner' });
    expect(dto.upNext[1]).toMatchObject({ occurrenceId: 'occ-later' });
  });
});

describe('EvergreenService.armCategory', () => {
  it('with no configured weekdays/times: inserts no occurrence and does not enqueue', async () => {
    const category = makeCategoryRow({ schedule: { weekdays: [], times: [] } });
    const campaign = makeCampaignRow();
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
    });
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, buildFakePublishing(), queue);

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('with a configured schedule: inserts a scheduled occurrence and enqueues a delayed job with deterministic jobId', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    const { db, inserts, occurrenceRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [makePostRow()],
    });
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, buildFakePublishing(), queue);

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(1);
    const inserted = inserts.occurrences[0] as {
      categoryId: string;
      campaignId: string;
      slotStatus: string;
      postIdRef: string;
    };
    expect(inserted.categoryId).toBe(CATEGORY_ID);
    expect(inserted.campaignId).toBe(CAMPAIGN_ID);
    expect(inserted.slotStatus).toBe('scheduled');
    expect(inserted.postIdRef).toBe(POST_ID); // picked at arm-time

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, jobData, jobOpts] = queue.add.mock.calls[0] as [
      string,
      { occurrenceId: string },
      { jobId: string; delay: number },
    ];
    const occurrenceId = occurrenceRows[0].id;
    expect(jobData).toEqual({ occurrenceId });
    expect(jobOpts.jobId).toBe(`evg-${occurrenceId}`);
    expect(jobOpts.delay).toBeGreaterThanOrEqual(0);

    // jobId written back onto the occurrence row.
    expect(occurrenceRows[0].jobId).toBe(jobOpts.jobId);
  });

  it('when no post is eligible at arm-time, still does nothing (no occurrence, no enqueue)', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    const { db, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [], // no posts in the pool → nothing eligible
    });
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, buildFakePublishing(), queue);

    await service.armCategory(
      category,
      campaign,
      new Date('2026-08-18T00:00:00Z'),
    );

    expect(inserts.occurrences).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('EvergreenService.fireOccurrence', () => {
  it('fires with an eligible post: calls materializeAndEnqueue with the selected variation caption + destination, bumps the post, writes postsRowId/jobId, and arms the next fire', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    const post = makePostRow({
      recycledCount: 1,
      variations: [
        { id: 'v1', caption: 'Variation caption', source: 'manual' },
      ],
      content: {
        mode: 'manual',
        postType: 'text',
        caption: 'Base caption',
        media: [],
        threadParts: [],
        templateIds: [],
        destination: { id: 'chan-dest-1', name: 'general' },
      },
    });
    const occurrence = makeOccurrenceRow();
    const channel = makeChannelRow({ id: 12, platform: 'facebook' });
    const { db, occurrenceRows, postRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [post],
      occurrenceRows: [occurrence],
      channelRows: [channel],
    });
    const publishing = buildFakePublishing();
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, publishing, queue);

    await service.fireOccurrence(OCCURRENCE_ID);

    expect(publishing.materializeAndEnqueue).toHaveBeenCalledTimes(1);
    const calls = publishing.materializeAndEnqueue.mock.calls as unknown as [
      {
        content: { caption: string; destination?: { id: string } };
        platform: string;
        channelId: string;
      },
    ][];
    const call = calls[0][0];
    // recycledCount=1, 1 variation → cycleLength=2, index = 1 % 2 = 1 → variations[0]
    expect(call.content.caption).toBe('Variation caption');
    expect(call.content.destination).toEqual({
      id: 'chan-dest-1',
      name: 'general',
    });
    expect(call.platform).toBe('facebook');
    expect(call.channelId).toBe('12');

    // post bumped
    expect(postRows[0].recycledCount).toBe(2);
    expect(postRows[0].lastPublishedAt).not.toBeNull();

    // occurrence updated
    expect(occurrenceRows[0].postsRowId).toBe('materialized-post-1');
    expect(occurrenceRows[0].jobId).toBe('materialized-job-1');
    expect(occurrenceRows[0].slotStatus).toBe('published');

    // next fire armed
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('with no eligible post pool-wide: marks the occurrence skipped, and armCategory is still attempted (no-op since nothing is eligible to arm against either)', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    // Only post in the pool is ineligible: status 'retired'.
    const post = makePostRow({ status: 'retired' });
    const occurrence = makeOccurrenceRow();
    const { db, occurrenceRows } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [post],
      occurrenceRows: [occurrence],
      channelRows: [makeChannelRow()],
    });
    const publishing = buildFakePublishing();
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, publishing, queue);

    await service.fireOccurrence(OCCURRENCE_ID);

    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
    expect(occurrenceRows[0].slotStatus).toBe('skipped');
    // No eligible post exists to arm the next occurrence against either (the
    // NOT NULL postIdRef FK means armCategory can't insert without a pick),
    // so the chain correctly stays dormant rather than inserting garbage.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('re-validates at fire time: when the stored postIdRef has since gone ineligible but another pool post is still eligible, fires the still-eligible one instead', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    // The occurrence's stored postIdRef points at a post that's since been
    // retired (e.g. edited after arm-time, before fire-time). A second pool
    // post is still eligible — fire-time re-validation must re-pick it
    // rather than blindly trusting/failing on the stale stored id.
    const stalePost = makePostRow({ id: 'post-stale', status: 'retired' });
    const eligiblePost = makePostRow({ id: 'post-eligible' });
    const occurrence = makeOccurrenceRow({ postIdRef: 'post-stale' });
    const { db, occurrenceRows, inserts } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [stalePost, eligiblePost],
      occurrenceRows: [occurrence],
      channelRows: [makeChannelRow()],
    });
    const publishing = buildFakePublishing();
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, publishing, queue);

    await service.fireOccurrence(OCCURRENCE_ID);

    expect(publishing.materializeAndEnqueue).toHaveBeenCalledTimes(1);
    expect(occurrenceRows[0].slotStatus).toBe('published');
    expect(occurrenceRows[0].postIdRef).toBe('post-eligible'); // re-picked, not the stale stored id
    expect(inserts.occurrences).toHaveLength(1); // next fire armed
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('when materializeAndEnqueue throws: the next fire is STILL armed (self-healing chain)', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
    });
    const campaign = makeCampaignRow();
    const post = makePostRow();
    const occurrence = makeOccurrenceRow();
    const { db } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [post],
      occurrenceRows: [occurrence],
      channelRows: [makeChannelRow()],
    });
    const publishing = buildFakePublishing();
    publishing.materializeAndEnqueue.mockRejectedValueOnce(
      new Error('publish boom'),
    );
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, publishing, queue);

    await expect(service.fireOccurrence(OCCURRENCE_ID)).rejects.toThrow(
      'publish boom',
    );

    expect(queue.add).toHaveBeenCalledTimes(1); // chain self-heals even though fire threw
  });

  it('when the category has gone inactive, does NOT arm a next fire', async () => {
    const category = makeCategoryRow({
      schedule: { weekdays: [1, 3, 5], times: ['09:00'] },
      isActive: false,
    });
    const campaign = makeCampaignRow();
    const post = makePostRow();
    const occurrence = makeOccurrenceRow();
    const { db } = buildFakeDb({
      campaignRows: [campaign],
      categoryRows: [category],
      postRows: [post],
      occurrenceRows: [occurrence],
      channelRows: [makeChannelRow()],
    });
    const publishing = buildFakePublishing();
    const queue = buildFakeQueue();
    const service = loadServiceWithFakeDb(db, publishing, queue);

    await service.fireOccurrence(OCCURRENCE_ID);

    expect(queue.add).not.toHaveBeenCalled();
  });
});
