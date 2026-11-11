/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

let currentRow: any;

const settle = (rows: () => any[]) => {
  const p: any = {
    then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
    returning: async () => rows(),
    limit: async () => rows(),
  };
  return p;
};

const mockDb = {
  select: jest.fn(() => ({
    from: () => ({ where: () => settle(() => [currentRow]) }),
  })),
  update: jest.fn(() => ({
    set: (v: any) => ({ where: () => settle(() => [{ ...currentRow, ...v }]) }),
  })),
  insert: jest.fn(() => ({ values: async () => undefined })),
  delete: jest.fn(() => ({ where: async () => undefined })),
  execute: jest.fn(async () => undefined),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PostService } from './post.service';

/**
 * D1: a scheduled post once handed X's thread to every channel. The
 * composer copied it into the row's shared `metadata.thread`, and the
 * scheduled publish merges shared metadata under each channel's own fields.
 * Rows scheduled before the fix still hold the copy.
 */
function make() {
  const publishers: Record<string, { publish: jest.Mock }> = {};
  const publisherFor = (platform: string) =>
    (publishers[platform] ??= {
      publish: jest.fn(async () => ({ platformPostId: `${platform}-1` })),
    });
  const svc = new PostService(
    {
      getChannelById: jest.fn(async () => ({
        connectionStatus: 'connected',
        platformAccountId: 'acc',
        metadata: {},
      })),
      getAccessToken: jest.fn(async () => 'tok'),
    } as any,
    { getPublisher: publisherFor } as any,
    {
      checkRateLimit: jest.fn(async () => ({ allowed: true })),
      checkChannelRateLimit: jest.fn(async () => ({ allowed: true })),
      recordRequest: jest.fn(async () => undefined),
      recordChannelRequest: jest.fn(async () => undefined),
    } as any,
    { getJob: jest.fn(async () => null), add: jest.fn() } as any,
    { add: jest.fn(async () => undefined) } as any,
    { has: () => false, get: () => undefined } as any,
    { emit: jest.fn() } as any,
    {
      syncPost: jest.fn(async () => undefined),
      loadPostLinks: jest.fn(async () => []),
      deleteEventsForLinks: jest.fn(async () => undefined),
    } as any,
    { syncFromPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
    { send: jest.fn() } as any, // PostReminderService
  );
  return {
    svc,
    metadataFor: (p: string) =>
      publisherFor(p).publish.mock.calls[0]?.[0]?.metadata,
  };
}

const X_THREAD = [{ text: 'x one' }, { text: 'x two' }, { text: 'x three' }];

/** A row as the old schedule path wrote it: X's thread copied to the shared metadata. */
const legacyScheduledRow = (platformContent: Record<string, unknown>) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  content: 'shared caption',
  jobId: null,
  mediaItems: [],
  targets: ['twitter', 'bluesky', 'mastodon', 'threads'].map((platform, i) => ({
    channelId: String(i + 1),
    platform,
    status: 'pending',
  })),
  platformContent,
  metadata: { source: 'composer', hashtags: [], thread: X_THREAD },
});

beforeEach(() => jest.clearAllMocks());

describe("PostService.publishPost - another platform's thread", () => {
  it("a Bluesky, Mastodon or Threads target with no thread of its own never receives X's", async () => {
    const { svc, metadataFor } = make();
    currentRow = legacyScheduledRow({
      twitter: { platformSpecific: { postType: 'thread', thread: X_THREAD } },
      // Bluesky has fields of its own, just no thread; the other two have
      // no entry at all.
      bluesky: { platformSpecific: { postType: 'post' } },
    });
    await svc.publishPost('p1', 'w1', 'u1');

    for (const p of ['bluesky', 'mastodon', 'threads']) {
      expect(metadataFor(p)).toBeDefined();
      expect(metadataFor(p).thread).toBeUndefined();
    }
    // X still gets its own.
    expect(metadataFor('twitter').thread).toEqual(X_THREAD);
  });

  it('a platform with a thread of its own gets that one', async () => {
    const own = [{ text: 'bsky one' }, { text: 'bsky two' }];
    const { svc, metadataFor } = make();
    currentRow = legacyScheduledRow({
      twitter: { platformSpecific: { thread: X_THREAD } },
      bluesky: { platformSpecific: { postType: 'thread', thread: own } },
    });
    await svc.publishPost('p1', 'w1', 'u1');

    expect(metadataFor('bluesky').thread).toEqual(own);
  });

  it('X switched back to Post does not resurrect the stale shared copy', async () => {
    const { svc, metadataFor } = make();
    currentRow = legacyScheduledRow({
      twitter: { platformSpecific: { postType: 'post' } },
    });
    await svc.publishPost('p1', 'w1', 'u1');

    expect(metadataFor('twitter').thread).toBeUndefined();
  });
});
