import { getTableName } from 'drizzle-orm';
import type { PostTarget, PostStatus } from '../drizzle/schema/posts.schema';
import type { CampaignSlotStatus } from '../drizzle/schema/campaigns.schema';
import type { CampaignStatusSyncListener as CampaignStatusSyncListenerType } from './campaign-status-sync.listener';

// ==========================================================================
// Table-name-routed fake db, mirroring `campaigns.service.spec.ts`'s
// `buildFakeDb` helper. `jest.isolateModules` gives the schema module (and
// therefore its exported table objects) a distinct module instance from the
// one imported here, so matching must go through `getTableName()` rather
// than reference equality.
// ==========================================================================

function makePostRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'post-1',
    workspaceId: 'ws-1',
    createdById: 'user-1',
    content: 'Hello world',
    mediaItems: [],
    targets: [{ channelId: '1', platform: 'twitter', status: 'published' }] as PostTarget[],
    status: 'published' as PostStatus,
    scheduledAt: null,
    publishedAt: new Date('2026-08-12T10:00:00Z'),
    lastError: null,
    platformContent: {},
    metadata: {
      campaignId: 'campaign-1',
      campaignSlot: { date: '2026-08-12', channelId: '1' },
    },
    jobId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-12T10:00:00Z'),
    ...overrides,
  };
}

function buildFakeDb(fixture: {
  outstandingSlotRows?: Record<string, unknown>[];
  campaignRow?: Record<string, unknown>;
}) {
  const updates: {
    slotUpdates: { set: Record<string, unknown> }[];
    campaignUpdates: { set: Record<string, unknown> }[];
  } = { slotUpdates: [], campaignUpdates: [] };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never);
          if (name === 'campaign_slot_content') {
            return Promise.resolve(fixture.outstandingSlotRows ?? []);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          const name = getTableName(table as never);
          if (name === 'campaign_slot_content') {
            updates.slotUpdates.push({ set });
          } else if (name === 'campaigns') {
            updates.campaignUpdates.push({ set });
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, updates };
}

/** Extracts the column-name -> value equality pairs out of a drizzle
 *  `and(eq(...), ...)` / bare `eq(...)` condition tree by walking `queryChunks`
 *  and picking (Column, Param) adjacency. Mirrors the helper in
 *  `campaigns.controller.spec.ts` — used by the multi-time (BUG C2) test to
 *  evaluate a WHERE clause against in-memory slot rows. */
function extractEqPairs(condition: unknown): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};
  if (!condition || typeof condition !== 'object') return pairs;

  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] as { name?: string; queryChunks?: unknown[] };
      const isColumn =
        chunk &&
        typeof chunk === 'object' &&
        'name' in chunk &&
        typeof chunk.name === 'string' &&
        'columnType' in (chunk as Record<string, unknown>);
      if (isColumn) {
        for (let j = i + 1; j < chunks.length; j += 1) {
          const candidate = chunks[j] as { value?: unknown };
          if (
            candidate &&
            typeof candidate === 'object' &&
            'value' in candidate &&
            !Array.isArray(candidate.value)
          ) {
            pairs[chunk.name as string] = candidate.value;
            break;
          }
        }
      }
      if (chunk && typeof chunk === 'object' && Array.isArray(chunk.queryChunks)) {
        Object.assign(pairs, extractEqPairs(chunk));
      }
    }
  }

  return pairs;
}

/**
 * Loads a fresh, isolated copy of the listener module with `../drizzle/db`
 * mocked to `fakeDb`. Scoped per-call via `jest.isolateModules` so tests
 * don't leak mocks into each other.
 */
function loadListenerWithFakeDb(fakeDb: unknown): CampaignStatusSyncListenerType {
  let ListenerCtor!: typeof CampaignStatusSyncListenerType;
  jest.isolateModules(() => {
    jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ListenerCtor = require('./campaign-status-sync.listener').CampaignStatusSyncListener;
  });
  return new ListenerCtor();
}

afterEach(() => {
  jest.dontMock('../drizzle/db');
  jest.resetModules();
});

describe('CampaignStatusSyncListener.syncFromPost', () => {
  it('marks the slot published on success', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'published' }) as never);

    expect(updates.slotUpdates).toHaveLength(1);
    const set = updates.slotUpdates[0].set;
    expect(set.slotStatus).toBe('published' satisfies CampaignSlotStatus);
    expect(set.publishedAt).toBeInstanceOf(Date);
    expect(set.lastError).toBeUndefined();
  });

  it('marks the slot failed with lastError from the target on failure', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(
      makePostRow({
        status: 'failed',
        lastError: 'Some channels failed to publish',
        targets: [
          { channelId: '1', platform: 'twitter', status: 'failed', errorMessage: 'Rate limited' },
        ] as PostTarget[],
      }) as never,
    );

    expect(updates.slotUpdates).toHaveLength(1);
    const set = updates.slotUpdates[0].set;
    expect(set.slotStatus).toBe('failed' satisfies CampaignSlotStatus);
    expect(set.lastError).toBe('Rate limited');
    expect(set.publishedAt).toBeUndefined();
  });

  it('falls back to a generic message when the failed target has no errorMessage', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(
      makePostRow({
        status: 'failed',
        targets: [{ channelId: '1', platform: 'twitter', status: 'failed' }] as PostTarget[],
      }) as never,
    );

    expect(updates.slotUpdates[0].set.lastError).toBe('Publish failed');
  });

  it('marks the slot published for a partially_published post', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'partially_published' }) as never);

    expect(updates.slotUpdates[0].set.slotStatus).toBe('published');
  });

  it('marks the slot publishing (non-terminal, no auto-complete check) for a publishing post', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'publishing' }) as never);

    expect(updates.slotUpdates).toHaveLength(1);
    expect(updates.slotUpdates[0].set.slotStatus).toBe('publishing');
    // Non-terminal — no campaign-completion check should have run.
    expect(updates.campaignUpdates).toHaveLength(0);
  });

  it('ignores a post with no campaignId metadata', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ metadata: {} }) as never);

    expect(updates.slotUpdates).toHaveLength(0);
    expect(updates.campaignUpdates).toHaveLength(0);
  });

  it('ignores a post with campaignId but no campaignSlot', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ metadata: { campaignId: 'campaign-1' } }) as never);

    expect(updates.slotUpdates).toHaveLength(0);
  });

  it('ignores a post whose status has no slot-status mapping (e.g. draft/scheduled)', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'scheduled' }) as never);

    expect(updates.slotUpdates).toHaveLength(0);
  });

  // ========================================================================
  // Auto-complete
  // ========================================================================

  it('auto-completes the campaign when the last terminal slot leaves none outstanding', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] }); // no scheduled/publishing left
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'published' }) as never);

    expect(updates.campaignUpdates).toHaveLength(1);
    expect(updates.campaignUpdates[0].set).toMatchObject({ status: 'completed' });
  });

  it('does NOT complete the campaign while other slots are still scheduled/publishing', async () => {
    const { db, updates } = buildFakeDb({
      outstandingSlotRows: [{ id: 'slot-2', slotStatus: 'scheduled' }],
    });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(makePostRow({ status: 'published' }) as never);

    expect(updates.slotUpdates).toHaveLength(1); // the slot itself still gets synced
    expect(updates.campaignUpdates).toHaveLength(0); // but campaign stays untouched
  });

  it('also runs the auto-complete check on a failed (terminal) post', async () => {
    const { db, updates } = buildFakeDb({ outstandingSlotRows: [] });
    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(
      makePostRow({
        status: 'failed',
        targets: [{ channelId: '1', platform: 'twitter', status: 'failed', errorMessage: 'x' }] as PostTarget[],
      }) as never,
    );

    // failed is terminal too, so auto-complete DOES run here.
    expect(updates.campaignUpdates).toHaveLength(1);
    expect(updates.campaignUpdates[0].set).toMatchObject({ status: 'completed' });
  });

  // ==========================================================================
  // Failure propagation — documents that `syncFromPost` itself does NOT
  // swallow a DB error; the non-propagation guard lives one layer up, in
  // `PostService`'s publish finalizer (`post.service.ts`), which wraps this
  // call in `void ...syncFromPost(...).catch(...)` so a transient failure
  // here can never re-throw into `publishPost` and trigger a BullMQ retry
  // that would re-publish already-succeeded targets. This test exists to
  // pin down *why* that caller-side guard is required.
  // ==========================================================================
  it('propagates a DB error from the slot update (caller is responsible for not letting this fail the publish path)', async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.reject(new Error('connection reset')),
        }),
      }),
    };
    const listener = loadListenerWithFakeDb(db);

    await expect(listener.syncFromPost(makePostRow({ status: 'published' }) as never)).rejects.toThrow(
      'connection reset',
    );
  });

  // ==========================================================================
  // BUG C2 — multi-time drip: two slots sharing (date, channelId) at different
  // times. Publishing the 09:00 post must flip ONLY the 09:00 slot; without
  // `time` in the WHERE clause both slots flip and the campaign completes
  // prematurely. This is a behavioural test — it evaluates the real WHERE the
  // listener builds against an in-memory two-slot table.
  // ==========================================================================
  it('flips ONLY the matching time-slot when two slots share date+channel (09:00 vs 17:00)', async () => {
    // Two pending slots on the same date+channel, different times.
    const slotTable: Record<string, unknown>[] = [
      { id: 'slot-am', campaignId: 'campaign-1', date: '2026-08-12', channelId: '1', time: '09:00', slotStatus: 'scheduled' },
      { id: 'slot-pm', campaignId: 'campaign-1', date: '2026-08-12', channelId: '1', time: '17:00', slotStatus: 'scheduled' },
    ];
    // Maps db column name -> in-memory row key.
    const COL: Record<string, string> = {
      campaign_id: 'campaignId',
      date: 'date',
      channel_id: 'channelId',
      time: 'time',
    };

    const db = {
      // maybeCompleteCampaign selects outstanding slots — return whatever is
      // still scheduled/publishing after the update so completion is realistic.
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(
              slotTable.filter(
                (r) => r.slotStatus === 'scheduled' || r.slotStatus === 'publishing',
              ),
            ),
        }),
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const pairs = extractEqPairs(cond);
            for (const row of slotTable) {
              const matches = Object.entries(pairs).every(([dbName, value]) => {
                const key = COL[dbName] ?? dbName;
                return row[key] === value;
              });
              if (matches) Object.assign(row, set);
            }
            return Promise.resolve();
          },
        }),
      }),
    };

    const listener = loadListenerWithFakeDb(db);

    await listener.syncFromPost(
      makePostRow({
        status: 'published',
        metadata: {
          campaignId: 'campaign-1',
          campaignSlot: { date: '2026-08-12', channelId: '1', time: '09:00' },
        },
      }) as never,
    );

    const am = slotTable.find((r) => r.id === 'slot-am')!;
    const pm = slotTable.find((r) => r.id === 'slot-pm')!;
    // Only the 09:00 slot published; the 17:00 slot stays scheduled.
    expect(am.slotStatus).toBe('published');
    expect(pm.slotStatus).toBe('scheduled');
    // 17:00 still outstanding -> campaign must NOT auto-complete.
    expect(am.publishedAt).toBeInstanceOf(Date);
  });
});
