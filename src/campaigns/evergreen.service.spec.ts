import { getTableName } from 'drizzle-orm';
import type { EvergreenService } from './evergreen.service';
import type {
  EvergreenCategory,
  EvergreenPost,
} from '../drizzle/schema/evergreen.schema';
import type { Campaign } from '../drizzle/schema/campaigns.schema';

// ==========================================================================
// Fake-DB test harness — mirrors campaigns.service.spec.ts's
// `loadServiceWithFakeDb` / table-name-routed `buildFakeDb` pattern exactly.
// ==========================================================================

/**
 * Loads a fresh, isolated copy of the service module with `../drizzle/db`
 * mocked to `fakeDb`. `jest.isolateModules` scopes the mock + require to
 * this call only, so tests don't leak mocks between each other.
 */
function loadServiceWithFakeDb(fakeDb: unknown): InstanceType<typeof EvergreenService> {
  let Ctor!: typeof EvergreenService;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Ctor = require('./evergreen.service').EvergreenService;
  });
  return new Ctor();
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

function makeCategoryRow(overrides: Partial<EvergreenCategory> = {}): EvergreenCategory {
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
}) {
  const campaignRows = fixture.campaignRows ?? [];
  const categoryRows = fixture.categoryRows ?? [];
  const postRows = fixture.postRows ?? [];

  const inserts: {
    campaigns: unknown[];
    categories: unknown[];
    posts: unknown[];
  } = { campaigns: [], categories: [], posts: [] };
  const deletes: { categoryIds: string[]; postIds: string[] } = {
    categoryIds: [],
    postIds: [],
  };

  function tableRows(name: string): Record<string, unknown>[] {
    if (name === 'campaigns') return campaignRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_categories')
      return categoryRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_posts')
      return postRows as unknown as Record<string, unknown>[];
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
            if (wanted.campaign_id !== undefined && r.campaignId !== wanted.campaign_id)
              return false;
            if (wanted.category_id !== undefined && r.categoryId !== wanted.category_id)
              return false;
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

  return { db, inserts, deletes, campaignRows, categoryRows, postRows };
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
    const named = node as { name?: string; columnType?: string; value?: unknown };
    if (typeof named.name === 'string' && typeof named.columnType === 'string') {
      pendingColumn = named.name;
    } else if (pendingColumn && named.value !== undefined && typeof named.value !== 'object') {
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
      schedule: { type: string; weekdays: number[]; times: string[]; loop: boolean };
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
    const inserted = inserts.categories[0] as { campaignId: string; name: string };
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

    const dto = await service.updateCategory(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, {
      name: 'Tips & Tricks',
    });

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

    const dto = await service.setCategoryActive(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, false);

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

    const dto = await service.removeCategory(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID);

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
    expect(dto.categories[0].posts[0].recyclePolicy).toEqual({ mode: 'forever' });
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

    const inserted = inserts.posts[0] as { recyclePolicy: { mode: string; maxCount?: number } };
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

    const dto = await service.updatePost(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, POST_ID, {
      minGapHours: 12,
    });

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

    const dto = await service.removePost(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, POST_ID);

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
    expect(new Date(dto.categories[0].nextRunAt as string).getTime()).not.toBeNaN();
    expect(dto.upNext).toEqual([]);
  });

  it('returns nextRunAt: null for a category with no weekdays/times configured', async () => {
    const campaignRow = makeCampaignRow();
    const categoryRow = makeCategoryRow({ schedule: { weekdays: [], times: [] } });
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

    await expect(service.assembleEvergreen('missing-id')).rejects.toThrow('Campaign not found');
  });
});
