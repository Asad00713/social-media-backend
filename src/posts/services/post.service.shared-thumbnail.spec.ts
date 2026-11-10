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
 * The scheduled / legacy publish path reads each channel's fields from the
 * stored `platformContent`. YouTube's designed thumbnail has to reach the
 * Facebook and LinkedIn publishers from here too, or a SCHEDULED post would
 * publish without the picture a publish-now post carries.
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

const PICTURE = 'https://cdn.example/thumb.jpg';

const row = (platforms: string[], youtube: Record<string, unknown>) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  content: 'hi',
  jobId: null,
  mediaItems: [{ type: 'video', url: 'https://cdn.example/v.mp4' }],
  targets: platforms.map((platform, i) => ({
    channelId: String(i + 1),
    platform,
    status: 'pending',
  })),
  platformContent: {
    youtube: { platformSpecific: youtube },
    facebook: { platformSpecific: { postType: 'post' } },
  },
});

beforeEach(() => jest.clearAllMocks());

describe('PostService.publishPost - YouTube’s thumbnail, shared', () => {
  it('hands Facebook and LinkedIn YouTube’s picture as `sharedThumbnailUrl`', async () => {
    const { svc, metadataFor } = make();
    currentRow = row(['youtube', 'facebook', 'linkedin'], {
      thumbnailUrl: PICTURE,
    });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(metadataFor('facebook')).toMatchObject({
      postType: 'post',
      sharedThumbnailUrl: PICTURE,
    });
    expect(metadataFor('linkedin').sharedThumbnailUrl).toBe(PICTURE);
    // YouTube sends its own, under its own key.
    expect(metadataFor('youtube').thumbnailUrl).toBe(PICTURE);
    expect('sharedThumbnailUrl' in metadataFor('youtube')).toBe(false);
  });

  it('hands nothing on from a Short', async () => {
    const { svc, metadataFor } = make();
    currentRow = row(['youtube', 'facebook'], {
      thumbnailUrl: PICTURE,
      isShort: true,
    });
    await svc.publishPost('p1', 'w1', 'u1');
    expect('sharedThumbnailUrl' in metadataFor('facebook')).toBe(false);
  });

  it('hands nothing on when YouTube is not a target of the post', async () => {
    const { svc, metadataFor } = make();
    currentRow = row(['facebook'], { thumbnailUrl: PICTURE });
    await svc.publishPost('p1', 'w1', 'u1');
    expect('sharedThumbnailUrl' in metadataFor('facebook')).toBe(false);
  });
});
