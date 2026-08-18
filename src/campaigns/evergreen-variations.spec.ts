import { getTableName } from 'drizzle-orm';
import type { EvergreenService } from './evergreen.service';
import type { EvergreenCategory, EvergreenPost } from '../drizzle/schema/evergreen.schema';
import type { Campaign } from '../drizzle/schema/campaigns.schema';

// ==========================================================================
// Fake-DB test harness — mirrors evergreen.service.spec.ts's
// `loadServiceWithFakeDb` / table-name-routed `buildFakeDb` pattern exactly,
// scoped down to just what generateVariations/addVariation/removeVariation
// touch (campaigns, categories, posts).
// ==========================================================================

function buildFakePublishing() {
  return {
    materializeAndEnqueue: jest.fn().mockResolvedValue({
      postId: 'materialized-post-1',
      jobId: 'materialized-job-1',
    }),
    cancelSlotJob: jest.fn().mockResolvedValue(undefined),
  };
}

function buildFakeQueue() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'queue-job-1' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
}

function buildFakeGroq(overrides: Partial<{ generateVariations: jest.Mock }> = {}) {
  return {
    generateVariations: jest.fn().mockResolvedValue(['V1', 'V2']),
    ...overrides,
  };
}

function buildFakeAiTokens() {
  return {
    executeWithTokens: jest.fn(
      async (
        _ws: string,
        _u: string,
        _op: string,
        _pl: string | undefined,
        _sum: string,
        fn: () => Promise<{ result: unknown; outputLength?: number }>,
      ) => {
        const { result } = await fn();
        return { result, usage: {} };
      },
    ),
  };
}

function loadServiceWithFakeDb(
  fakeDb: unknown,
  publishing: ReturnType<typeof buildFakePublishing> = buildFakePublishing(),
  queue: ReturnType<typeof buildFakeQueue> = buildFakeQueue(),
  groq: ReturnType<typeof buildFakeGroq> = buildFakeGroq(),
  aiTokens: ReturnType<typeof buildFakeAiTokens> = buildFakeAiTokens(),
): InstanceType<typeof EvergreenService> {
  let Ctor!: typeof EvergreenService;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    Ctor = require('./evergreen.service').EvergreenService;
  });
  return new Ctor(publishing as never, queue as never, groq as never, aiTokens as never);
}

afterEach(() => {
  jest.dontMock('../drizzle/db');
  jest.resetModules();
});

const WORKSPACE_ID = 'ws-1';
const CAMPAIGN_ID = 'campaign-1';
const CATEGORY_ID = 'category-1';
const POST_ID = 'post-1';
const USER_ID = 'user-1';

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

interface FakeChannelRow {
  id: number;
  platform: string;
}

function makeChannelRow(
  overrides: Partial<FakeChannelRow> = {},
): FakeChannelRow {
  return { id: 12, platform: 'facebook', ...overrides };
}

/** Table-name-routed, stateful fake db (scoped subset of the full harness in
 *  evergreen.service.spec.ts). SELECT always returns CLONES — never the same
 *  reference the fixture holds — per the mandatory no-in-place-mutation
 *  ruling (this is exactly what catches accidental partial-write bugs: if
 *  the service mutated the row in place before the DB write, this harness
 *  wouldn't reveal it — but if it mutates a cloned/derived object and only
 *  persists on success, the update() call itself is the assertion point). */
function buildFakeDb(fixture: {
  campaignRows?: Campaign[];
  categoryRows?: EvergreenCategory[];
  postRows?: EvergreenPost[];
  channelRows?: FakeChannelRow[];
}) {
  const campaignRows = fixture.campaignRows ?? [];
  const categoryRows = fixture.categoryRows ?? [];
  const postRows = fixture.postRows ?? [];
  const channelRows = fixture.channelRows ?? [];

  const updates: { posts: Record<string, unknown>[] } = { posts: [] };

  function tableRows(name: string): Record<string, unknown>[] {
    if (name === 'campaigns')
      return campaignRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_categories')
      return categoryRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_posts')
      return postRows as unknown as Record<string, unknown>[];
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
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (whereCond: unknown) => {
          const name = getTableName(table as never);
          const wanted = extractEqValues(whereCond);
          const rows = tableRows(name);
          const row = rows.find((r) => r.id === wanted.id);
          if (row) {
            Object.assign(row, set);
            if (name === 'campaign_evergreen_posts') {
              updates.posts.push({ ...row });
            }
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, updates, campaignRows, categoryRows, postRows, channelRows };
}

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

describe('EvergreenService.generateVariations', () => {
  it('appends AI-generated variations (source: "ai") with unique ids, preserving existing variations', async () => {
    const existingVariation = { id: 'v-existing', caption: 'Existing', source: 'manual' as const };
    const post = makePostRow({ variations: [existingVariation] });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
      channelRows: [makeChannelRow()],
    });
    const groq = buildFakeGroq();
    const aiTokens = buildFakeAiTokens();
    const service = loadServiceWithFakeDb(
      db,
      buildFakePublishing(),
      buildFakeQueue(),
      groq,
      aiTokens,
    );

    const dto = await service.generateVariations(
      WORKSPACE_ID,
      USER_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      POST_ID,
      2,
    );

    expect(groq.generateVariations).toHaveBeenCalledWith(
      'Hello world',
      'facebook',
      2,
    );
    expect(aiTokens.executeWithTokens).toHaveBeenCalledTimes(1);
    expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe('generate_variations');

    const persisted = postRows[0].variations;
    expect(persisted).toHaveLength(3);
    expect(persisted[0]).toEqual(existingVariation);
    const aiVariations = persisted.slice(1);
    expect(aiVariations.map((v) => v.caption)).toEqual(['V1', 'V2']);
    expect(aiVariations.every((v) => v.source === 'ai')).toBe(true);
    const ids = aiVariations.map((v) => v.id);
    expect(new Set(ids).size).toBe(2); // unique ids

    const dtoPost = dto.categories[0].posts[0];
    expect(dtoPost.variations).toHaveLength(3);
  });

  it('when groq.generateVariations throws: rejects and does NOT write to the post (no partial write)', async () => {
    const existingVariation = { id: 'v-existing', caption: 'Existing', source: 'manual' as const };
    const post = makePostRow({ variations: [existingVariation] });
    const { db, postRows, updates } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
      channelRows: [makeChannelRow()],
    });
    const groq = buildFakeGroq({
      generateVariations: jest.fn().mockRejectedValue(new Error('groq boom')),
    });
    const aiTokens = buildFakeAiTokens();
    const service = loadServiceWithFakeDb(
      db,
      buildFakePublishing(),
      buildFakeQueue(),
      groq,
      aiTokens,
    );

    await expect(
      service.generateVariations(
        WORKSPACE_ID,
        USER_ID,
        CAMPAIGN_ID,
        CATEGORY_ID,
        POST_ID,
        2,
      ),
    ).rejects.toThrow('groq boom');

    // No partial write: post.variations unchanged, no update() call reached posts.
    expect(postRows[0].variations).toEqual([existingVariation]);
    expect(updates.posts).toHaveLength(0);
  });

  it('when executeWithTokens itself throws (e.g. insufficient tokens): rejects and does NOT write to the post', async () => {
    const post = makePostRow({ variations: [] });
    const { db, postRows, updates } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
      channelRows: [makeChannelRow()],
    });
    const groq = buildFakeGroq();
    const aiTokens = {
      executeWithTokens: jest.fn().mockRejectedValue(new Error('insufficient tokens')),
    };
    const service = loadServiceWithFakeDb(
      db,
      buildFakePublishing(),
      buildFakeQueue(),
      groq,
      aiTokens as never,
    );

    await expect(
      service.generateVariations(
        WORKSPACE_ID,
        USER_ID,
        CAMPAIGN_ID,
        CATEGORY_ID,
        POST_ID,
        2,
      ),
    ).rejects.toThrow('insufficient tokens');

    expect(postRows[0].variations).toEqual([]);
    expect(updates.posts).toHaveLength(0);
  });
});

describe('EvergreenService.addVariation', () => {
  it('appends a manual variation (source: "manual")', async () => {
    const post = makePostRow({ variations: [] });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.addVariation(WORKSPACE_ID, CAMPAIGN_ID, CATEGORY_ID, POST_ID, {
      caption: 'Manual caption',
    });

    expect(postRows[0].variations).toHaveLength(1);
    expect(postRows[0].variations[0]).toMatchObject({
      caption: 'Manual caption',
      source: 'manual',
    });
    expect(typeof postRows[0].variations[0].id).toBe('string');

    expect(dto.categories[0].posts[0].variations).toHaveLength(1);
  });
});

describe('EvergreenService.removeVariation', () => {
  it('filters out the variation by id', async () => {
    const keep = { id: 'v-keep', caption: 'Keep me', source: 'manual' as const };
    const remove = { id: 'v-remove', caption: 'Remove me', source: 'ai' as const };
    const post = makePostRow({ variations: [keep, remove] });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const service = loadServiceWithFakeDb(db);

    const dto = await service.removeVariation(
      WORKSPACE_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      POST_ID,
      'v-remove',
    );

    expect(postRows[0].variations).toEqual([keep]);
    expect(dto.categories[0].posts[0].variations).toEqual([keep]);
  });
});
