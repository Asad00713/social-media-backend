import { getTableName } from 'drizzle-orm';
import type { EvergreenScoringService } from './evergreen-scoring.service';
import type {
  EvergreenCategory,
  EvergreenOccurrence,
  EvergreenPost,
} from '../drizzle/schema/evergreen.schema';
import type { Campaign } from '../drizzle/schema/campaigns.schema';
import type { PostMetricSnapshot } from '../drizzle/schema/post-metric-snapshots.schema';

// ==========================================================================
// Fake-DB test harness — mirrors evergreen-variations.spec.ts's
// `loadServiceWithFakeDb` / table-name-routed `buildFakeDb` pattern, scoped
// to what EvergreenScoringService touches (campaigns, categories, posts,
// occurrences, post_metric_snapshots).
// ==========================================================================

function buildFakeGroq(overrides: Partial<{ checkFreshness: jest.Mock }> = {}) {
  return {
    checkFreshness: jest.fn().mockResolvedValue({
      isStale: false,
      reason: null,
    }),
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
  groq: ReturnType<typeof buildFakeGroq> = buildFakeGroq(),
  aiTokens: ReturnType<typeof buildFakeAiTokens> = buildFakeAiTokens(),
): InstanceType<typeof EvergreenScoringService> {
  let Ctor!: typeof EvergreenScoringService;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    Ctor = require('./evergreen-scoring.service').EvergreenScoringService;
  });
  return new Ctor(groq as never, aiTokens as never);
}

afterEach(() => {
  jest.dontMock('../drizzle/db');
  jest.resetModules();
});

const WORKSPACE_ID = 'ws-1';
const CAMPAIGN_ID = 'campaign-1';
const CATEGORY_ID = 'category-1';
const USER_ID = 'user-1';

function makeCampaignRow(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    workspaceId: WORKSPACE_ID,
    createdById: 'user-1',
    name: 'Evergreen A',
    description: null,
    type: 'evergreen',
    status: 'active',
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
    launchedAt: new Date('2026-08-18T00:00:00Z'),
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
    id: 'post-1',
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
    id: 'occ-1',
    campaignId: CAMPAIGN_ID,
    categoryId: CATEGORY_ID,
    postIdRef: 'post-1',
    variationId: null,
    channelId: '12',
    scheduledAt: new Date('2026-08-10T09:00:00Z'),
    slotStatus: 'published',
    postsRowId: 'posts-row-1',
    jobId: null,
    publishedAt: new Date('2026-08-10T09:00:00Z'),
    lastError: null,
    createdAt: new Date('2026-08-10T09:00:00Z'),
    ...overrides,
  } as EvergreenOccurrence;
}

function makeSnapshotRow(
  overrides: Partial<PostMetricSnapshot> = {},
): PostMetricSnapshot {
  return {
    id: 1,
    postId: 'posts-row-1',
    channelId: 12,
    snapshotAt: new Date('2026-08-11T09:00:00Z'),
    ageBucket: '24h',
    likesCount: 10,
    commentsCount: 5,
    sharesCount: 2,
    impressionsCount: 100,
    reachCount: 90,
    platformMetrics: {},
    metricsSchemaVersion: 1,
    fetchedAt: new Date('2026-08-11T09:00:00Z'),
    syncStatus: 'ok',
    ...overrides,
  } as unknown as PostMetricSnapshot;
}

/** Table-name-routed, stateful fake db. SELECT always returns CLONES. */
function buildFakeDb(fixture: {
  campaignRows?: Campaign[];
  categoryRows?: EvergreenCategory[];
  postRows?: EvergreenPost[];
  occurrenceRows?: EvergreenOccurrence[];
  snapshotRows?: PostMetricSnapshot[];
}) {
  const campaignRows = fixture.campaignRows ?? [];
  const categoryRows = fixture.categoryRows ?? [];
  const postRows = fixture.postRows ?? [];
  const occurrenceRows = fixture.occurrenceRows ?? [];
  const snapshotRows = fixture.snapshotRows ?? [];

  const updates: { posts: Record<string, unknown>[] } = { posts: [] };

  function tableRows(name: string): Record<string, unknown>[] {
    if (name === 'campaigns')
      return campaignRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_categories')
      return categoryRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_posts')
      return postRows as unknown as Record<string, unknown>[];
    if (name === 'campaign_evergreen_occurrences')
      return occurrenceRows as unknown as Record<string, unknown>[];
    if (name === 'post_metric_snapshots')
      return snapshotRows as unknown as Record<string, unknown>[];
    return [];
  }

  const db = {
    select: (_sel?: unknown) => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);

        const resolveAll = () =>
          Promise.resolve(tableRows(name).map((r) => ({ ...r })));

        return {
          where: (whereCond: unknown) => {
            const rows = tableRows(name);
            const wanted = extractEqValues(whereCond);
            const wantedIn = extractInValues(whereCond);
            const filtered = rows.filter((r) => {
              if (wanted.id !== undefined && r.id !== wanted.id) return false;
              if (
                wanted.workspace_id !== undefined &&
                r.workspaceId !== wanted.workspace_id
              )
                return false;
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
              if (
                wanted.post_id_ref !== undefined &&
                r.postIdRef !== wanted.post_id_ref
              )
                return false;
              if (wanted.post_id !== undefined && r.postId !== wanted.post_id)
                return false;
              if (
                wantedIn.post_id !== undefined &&
                !wantedIn.post_id.includes(r.postId as string)
              )
                return false;
              return true;
            });
            // MANDATORY: clones, never fixture references.
            return Promise.resolve(filtered.map((r) => ({ ...r })));
          },
          // Support `db.select().from(table)` with no `.where()` (used to
          // load the full campaign/category/post pool up front).
          then: (resolve: (v: unknown) => unknown) => resolveAll().then(resolve),
        };
      },
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

  return {
    db,
    updates,
    campaignRows,
    categoryRows,
    postRows,
    occurrenceRows,
    snapshotRows,
  };
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

/** Extracts `inArray(col, [...])`-style conditions: `{ post_id: ['a','b'] }`.
 *  Drizzle's `inArray` SQL shape is `queryChunks: [prefix, <column>, " in ",
 *  [<param>, <param>, ...], suffix]` — the params array is a plain array of
 *  `{ value, encoder }` objects (not itself carrying a `columnType`), so it
 *  needs its own branch distinct from the single-value `eq()` case. */
function extractInValues(cond: unknown): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  let pendingColumn: string | undefined;
  function walk(node: unknown): void {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      // A raw array of param nodes (the `inArray` values list) — only
      // meaningful if we just saw a column name.
      const isParamList =
        node.length > 0 &&
        node.every(
          (n) =>
            n != null &&
            typeof n === 'object' &&
            'value' in (n as Record<string, unknown>) &&
            !Array.isArray((n as { value?: unknown }).value),
        );
      if (pendingColumn && isParamList) {
        result[pendingColumn] = node.map(
          (n) => (n as { value: unknown }).value,
        );
        pendingColumn = undefined;
        return;
      }
      for (const c of node) walk(c);
      return;
    }
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
    }
    // NOTE: deliberately no "else if (Array.isArray(named.value))" branch
    // here — raw SQL text fragments (e.g. the `" in "` operator chunk) are
    // ALSO shaped as `{ value: [...] }` with string contents, and would be
    // wrongly captured as the values list. The actual param list only
    // arrives as a raw top-level array (handled by the `Array.isArray(node)`
    // branch above), never as a `.value` array on an object node.
  }
  walk(cond);
  return result;
}

// ==========================================================================
// Tests
// ==========================================================================

describe('EvergreenScoringService.recomputeScores', () => {
  it('normalizes engagement to [0,1] across the pool and leaves unsnapshotted posts null', async () => {
    const postHigh = makePostRow({ id: 'post-high' });
    const postLow = makePostRow({ id: 'post-low' });
    const postNone = makePostRow({ id: 'post-none' });

    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [postHigh, postLow, postNone],
      occurrenceRows: [
        makeOccurrenceRow({
          id: 'occ-high',
          postIdRef: 'post-high',
          postsRowId: 'posts-row-high',
        }),
        makeOccurrenceRow({
          id: 'occ-low',
          postIdRef: 'post-low',
          postsRowId: 'posts-row-low',
        }),
        // post-none has no occurrence at all — never fired yet.
      ],
      snapshotRows: [
        // High engagement post: 100 likes + 50 comments + 20 shares = 170
        makeSnapshotRow({
          id: 1,
          postId: 'posts-row-high',
          likesCount: 100,
          commentsCount: 50,
          sharesCount: 20,
          snapshotAt: new Date('2026-08-11T09:00:00Z'),
        }),
        // Low engagement post: 1 like + 0 comments + 0 shares = 1
        makeSnapshotRow({
          id: 2,
          postId: 'posts-row-low',
          likesCount: 1,
          commentsCount: 0,
          sharesCount: 0,
          snapshotAt: new Date('2026-08-11T09:00:00Z'),
        }),
      ],
    });

    const service = loadServiceWithFakeDb(db);
    await service.recomputeScores(CAMPAIGN_ID);

    const high = postRows.find((p) => p.id === 'post-high')!;
    const low = postRows.find((p) => p.id === 'post-low')!;
    const none = postRows.find((p) => p.id === 'post-none')!;

    expect(high.performanceScore).toBe(1);
    expect(low.performanceScore).toBe(0);
    // Never-snapshotted post stays null — NOT 0 — so it isn't wrongly sunk
    // in the rotation picker.
    expect(none.performanceScore).toBeNull();
  });

  it('does not throw on an empty snapshot set (brand-new campaign) and leaves all scores null', async () => {
    const post = makePostRow({ id: 'post-fresh' });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
      occurrenceRows: [],
      snapshotRows: [],
    });

    const service = loadServiceWithFakeDb(db);

    await expect(service.recomputeScores(CAMPAIGN_ID)).resolves.not.toThrow();
    expect(postRows[0].performanceScore).toBeNull();
  });

  it('uses only the latest snapshot per post row (not a sum across snapshots)', async () => {
    const post = makePostRow({ id: 'post-1' });
    const other = makePostRow({ id: 'post-2' });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post, other],
      occurrenceRows: [
        makeOccurrenceRow({
          id: 'occ-1',
          postIdRef: 'post-1',
          postsRowId: 'posts-row-1',
        }),
        makeOccurrenceRow({
          id: 'occ-2',
          postIdRef: 'post-2',
          postsRowId: 'posts-row-2',
        }),
      ],
      snapshotRows: [
        // Older, larger snapshot — should be ignored in favor of latest.
        makeSnapshotRow({
          id: 1,
          postId: 'posts-row-1',
          likesCount: 1000,
          commentsCount: 0,
          sharesCount: 0,
          snapshotAt: new Date('2026-08-01T00:00:00Z'),
        }),
        // Latest snapshot — this is what should count.
        makeSnapshotRow({
          id: 2,
          postId: 'posts-row-1',
          likesCount: 5,
          commentsCount: 0,
          sharesCount: 0,
          snapshotAt: new Date('2026-08-15T00:00:00Z'),
        }),
        makeSnapshotRow({
          id: 3,
          postId: 'posts-row-2',
          likesCount: 50,
          commentsCount: 0,
          sharesCount: 0,
          snapshotAt: new Date('2026-08-15T00:00:00Z'),
        }),
      ],
    });

    const service = loadServiceWithFakeDb(db);
    await service.recomputeScores(CAMPAIGN_ID);

    const p1 = postRows.find((p) => p.id === 'post-1')!;
    const p2 = postRows.find((p) => p.id === 'post-2')!;
    // post-1's latest (5) << post-2's (50), so post-1 should score near 0,
    // not near 1 (which the stale 1000-like snapshot would have produced).
    expect(p1.performanceScore).toBe(0);
    expect(p2.performanceScore).toBe(1);
  });
});

describe('EvergreenScoringService.checkFreshness', () => {
  it('sets isStale/staleReason from a Groq verdict and returns it', async () => {
    const post = makePostRow({ id: 'post-1', isStale: false, staleReason: null });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const groq = buildFakeGroq({
      checkFreshness: jest
        .fn()
        .mockResolvedValue({ isStale: true, reason: 'mentions 2025' }),
    });
    const service = loadServiceWithFakeDb(db, groq, buildFakeAiTokens());

    const verdict = await service.checkFreshness(
      WORKSPACE_ID,
      USER_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      'post-1',
    );

    expect(verdict).toEqual({ isStale: true, reason: 'mentions 2025' });
    const updated = postRows.find((p) => p.id === 'post-1')!;
    expect(updated.isStale).toBe(true);
    expect(updated.staleReason).toBe('mentions 2025');
  });

  it('on Groq throw: returns {isStale:false, reason:null} and does NOT write to the post', async () => {
    const post = makePostRow({ id: 'post-1', isStale: false, staleReason: null });
    const { db, updates } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const groq = buildFakeGroq({
      checkFreshness: jest.fn().mockRejectedValue(new Error('groq boom')),
    });
    const service = loadServiceWithFakeDb(db, groq, buildFakeAiTokens());

    const verdict = await service.checkFreshness(
      WORKSPACE_ID,
      USER_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      'post-1',
    );

    expect(verdict).toEqual({ isStale: false, reason: null });
    expect(updates.posts).toHaveLength(0);
  });

  it('on executeWithTokens throw (e.g. insufficient tokens): returns {isStale:false, reason:null}, no write', async () => {
    const post = makePostRow({ id: 'post-1', isStale: false, staleReason: null });
    const { db, updates } = buildFakeDb({
      campaignRows: [makeCampaignRow()],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const groq = buildFakeGroq();
    const aiTokens = {
      executeWithTokens: jest
        .fn()
        .mockRejectedValue(new Error('insufficient tokens')),
    };
    const service = loadServiceWithFakeDb(db, groq, aiTokens as never);

    const verdict = await service.checkFreshness(
      WORKSPACE_ID,
      USER_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      'post-1',
    );

    expect(verdict).toEqual({ isStale: false, reason: null });
    expect(updates.posts).toHaveLength(0);
  });

  // FIX 2 (M2 — IDOR): checkFreshness validated the post -> category ->
  // campaign chain but never bound campaignId to workspaceId, unlike every
  // other evergreen mutation (which calls loadOwnedCampaign(workspaceId,
  // campaignId) first). A caller from ANOTHER workspace who knows/guesses a
  // campaignId/categoryId/postId triple could run (and pay for) a freshness
  // check against content they don't own.
  it('throws when campaignId does not belong to workspaceId (IDOR guard), and does not call Groq or write', async () => {
    const post = makePostRow({ id: 'post-1', isStale: false, staleReason: null });
    const { db, updates } = buildFakeDb({
      // Campaign is owned by a DIFFERENT workspace than the caller passes.
      campaignRows: [makeCampaignRow({ workspaceId: 'ws-other' })],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const groq = buildFakeGroq();
    const service = loadServiceWithFakeDb(db, groq, buildFakeAiTokens());

    await expect(
      service.checkFreshness(
        WORKSPACE_ID, // caller's workspace — does NOT own CAMPAIGN_ID
        USER_ID,
        CAMPAIGN_ID,
        CATEGORY_ID,
        'post-1',
      ),
    ).rejects.toThrow();

    expect(groq.checkFreshness).not.toHaveBeenCalled();
    expect(updates.posts).toHaveLength(0);
  });

  it('still works normally for a campaign the workspace owns (regression)', async () => {
    const post = makePostRow({ id: 'post-1', isStale: false, staleReason: null });
    const { db, postRows } = buildFakeDb({
      campaignRows: [makeCampaignRow({ workspaceId: WORKSPACE_ID })],
      categoryRows: [makeCategoryRow()],
      postRows: [post],
    });
    const groq = buildFakeGroq({
      checkFreshness: jest
        .fn()
        .mockResolvedValue({ isStale: true, reason: 'mentions 2025' }),
    });
    const service = loadServiceWithFakeDb(db, groq, buildFakeAiTokens());

    const verdict = await service.checkFreshness(
      WORKSPACE_ID,
      USER_ID,
      CAMPAIGN_ID,
      CATEGORY_ID,
      'post-1',
    );

    expect(verdict).toEqual({ isStale: true, reason: 'mentions 2025' });
    const updated = postRows.find((p) => p.id === 'post-1')!;
    expect(updated.isStale).toBe(true);
  });
});
