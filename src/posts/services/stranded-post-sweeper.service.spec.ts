import { StrandedPostSweeperService } from './stranded-post-sweeper.service';

/**
 * The db module is a live pool at import time, so it is replaced wholesale.
 * `where()` captures the predicate the query was built with, which is what
 * the window tests assert on.
 */
const selected: unknown[] = [];
const history: unknown[] = [];
/** Predicates the service built, so a test can assert what it filtered on. */
const wherePredicates: unknown[] = [];

/**
 * Flattens a drizzle `SQL` into readable text. Its chunks hold column objects
 * and raw operator strings, and the graph is circular, so JSON.stringify
 * cannot be used.
 */
function describe_(node: unknown, depth = 0): string {
  if (depth > 6 || node == null) return '';
  if (typeof node === 'string') return node;
  const anyNode = node as Record<string, any>;
  if (typeof anyNode.name === 'string') return anyNode.name; // a column
  if (Array.isArray(anyNode.queryChunks)) {
    return anyNode.queryChunks
      .map((c: unknown) => describe_(c, depth + 1))
      .join(' ');
  }
  if (Array.isArray(anyNode.value)) {
    return anyNode.value.map((c: unknown) => describe_(c, depth + 1)).join(' ');
  }
  return '';
}
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // `where()` is awaited directly by the history query and chained with
        // `.limit()` by the post query, so it must be thenable *and* chainable.
        where: (predicate: unknown) => {
          wherePredicates.push(predicate);
          const rows = Promise.resolve(history);
          return Object.assign(rows, {
            limit: () => Promise.resolve(selected),
          });
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  },
}));
import type { PostTarget } from '../../drizzle/schema/posts.schema';

/**
 * The sweeper's whole contract is "write bookkeeping, never call a platform".
 * These drive the private resolver directly, because what matters is the
 * decision it makes per target — the SQL around it is plumbing.
 */
type Resolver = (
  targets: PostTarget[],
  published: Map<string, Record<string, unknown>>,
) => { targets: PostTarget[]; status: string };

function resolverOf(service: StrandedPostSweeperService): Resolver {
  return (
    service as unknown as { resolveTargets: Resolver }
  ).resolveTargets.bind(service);
}

function target(overrides: Partial<PostTarget> = {}): PostTarget {
  return {
    channelId: '1',
    platform: 'twitter',
    status: 'scheduled',
    ...overrides,
  } as PostTarget;
}

describe('StrandedPostSweeperService', () => {
  const service = new StrandedPostSweeperService();
  const resolve = resolverOf(service);

  describe('a target the history proves published', () => {
    it('is marked published and keeps the platform ids', () => {
      const { targets, status } = resolve(
        [target({ channelId: '7' })],
        new Map([
          [
            '7',
            { platformPostId: 'tw_123', platformPostUrl: 'https://x.com/1' },
          ],
        ]),
      );

      expect(targets[0].status).toBe('published');
      expect(targets[0].platformPostId).toBe('tw_123');
      expect(targets[0].platformPostUrl).toBe('https://x.com/1');
      expect(status).toBe('published');
    });

    /**
     * The reason this sweeper reads history at all. `posts.targets` is written
     * once, at the end of the publish loop, so a crash loses every per-target
     * outcome — but `post_history` is committed inside the loop and survives.
     * Resolving a published target back to anything retryable would publish
     * the same content twice.
     */
    it('is NEVER left in a state that could publish again', () => {
      const { targets } = resolve(
        [target({ channelId: '7' })],
        new Map([['7', { platformPostId: 'tw_123' }]]),
      );

      expect(targets[0].status).not.toBe('scheduled');
      expect(targets[0].status).not.toBe('publishing');
      expect(targets[0].status).toBe('published');
    });

    it('clears any stale error from an earlier attempt', () => {
      const { targets } = resolve(
        [
          target({
            channelId: '7',
            errorMessage: 'old failure',
            errorCode: 'auth' as PostTarget['errorCode'],
          }),
        ],
        new Map([['7', { platformPostId: 'tw_1' }]]),
      );

      expect(targets[0].errorMessage).toBeUndefined();
      expect(targets[0].errorCode).toBeUndefined();
    });
  });

  describe('a target with no history', () => {
    /**
     * No history row means the platform call never happened. Failing it hands
     * the decision to the author instead of publishing something hours late on
     * their behalf — a post scheduled for 9am should not quietly go out at 3pm
     * because a sweeper decided to finish the job.
     */
    it('is failed with an explanation, not retried automatically', () => {
      const { targets, status } = resolve([target({ channelId: '9' })], new Map());

      expect(targets[0].status).toBe('failed');
      expect(targets[0].errorMessage).toMatch(/interrupted/i);
      expect(status).toBe('failed');
    });
  });

  describe('targets already settled before the crash', () => {
    it('leaves a published target untouched even with no history', () => {
      const original = target({
        channelId: '3',
        status: 'published',
        platformPostId: 'fb_9',
      });

      const { targets } = resolve([original], new Map());

      expect(targets[0]).toEqual(original);
    });

    it('leaves a failed target failed, with its original error', () => {
      const original = target({
        channelId: '4',
        status: 'failed',
        errorMessage: 'Token expired',
      });

      const { targets } = resolve([original], new Map());

      expect(targets[0].errorMessage).toBe('Token expired');
    });
  });

  describe('the resulting post status', () => {
    it('is partially_published when some channels went out and others did not', () => {
      const { status } = resolve(
        [target({ channelId: '1' }), target({ channelId: '2' })],
        new Map([['1', { platformPostId: 'a' }]]),
      );

      expect(status).toBe('partially_published');
    });

    it('is published when every channel went out', () => {
      const { status } = resolve(
        [target({ channelId: '1' }), target({ channelId: '2' })],
        new Map([
          ['1', { platformPostId: 'a' }],
          ['2', { platformPostId: 'b' }],
        ]),
      );

      expect(status).toBe('published');
    });

    it('is failed when nothing went out', () => {
      const { status } = resolve(
        [target({ channelId: '1' }), target({ channelId: '2' })],
        new Map(),
      );

      expect(status).toBe('failed');
    });

    it('counts a pre-existing published target towards the outcome', () => {
      const { status } = resolve(
        [
          target({ channelId: '1', status: 'published' }),
          target({ channelId: '2' }),
        ],
        new Map(),
      );

      expect(status).toBe('partially_published');
    });
  });

  it('handles a post with no targets at all', () => {
    const { targets, status } = resolve([], new Map());

    expect(targets).toEqual([]);
    expect(status).toBe('failed');
  });
});

describe('resolveIfStranded (the manual-retry door)', () => {
  const service = new StrandedPostSweeperService();

  beforeEach(() => {
    selected.length = 0;
    history.length = 0;
    wherePredicates.length = 0;
  });

  /**
   * The guard that prevents a double-post. A publish genuinely in flight also
   * sits in `publishing`; the only thing separating it from an abandoned row
   * is how long it has been there. The query carries that window, so a row
   * inside it is not returned and this must refuse.
   */
  it('refuses a row that is still inside the window', async () => {
    // The mocked query returns nothing, standing in for "no row matched the
    // status + age predicate".
    await expect(service.resolveIfStranded('post-1')).resolves.toBe(false);
  });

  /**
   * The age comparison is the guard, so the test has to see it. Returning no
   * rows passes whether or not the query filtered on age — which is exactly
   * how a dropped guard would slip through. Asserting the predicate was built
   * with a `lt` on `updated_at` is what actually fails if someone removes it,
   * and removing it would let the sweeper resolve a publish still in flight.
   */
  it('filters on the age of the row, not only its status', async () => {
    await service.resolveIfStranded('post-1');

    expect(describe_(wherePredicates[0])).toMatch(/updated_at.*<|<.*updated_at/s);
  });

  it('repairs a row that is past the window', async () => {
    selected.push({ id: 'post-1', targets: [], publishedAt: null });

    await expect(service.resolveIfStranded('post-1')).resolves.toBe(true);
  });
});
