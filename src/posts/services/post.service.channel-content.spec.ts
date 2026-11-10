/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

let currentRow: any;
let updates: any[];
let inserts: any[];

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
    set: (v: any) => {
      updates.push(v);
      return { where: () => settle(() => [{ ...currentRow, ...v }]) };
    },
  })),
  insert: jest.fn(() => ({
    values: async (v: any) => {
      inserts.push(v);
    },
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PostService } from './post.service';

function make() {
  const publisher = {
    publish: jest.fn(async () => ({
      platformPostId: 'p-1',
      platformPostUrl: 'https://p/1',
    })),
  };
  const rate = {
    checkRateLimit: jest.fn(async () => ({ allowed: true })),
    checkChannelRateLimit: jest.fn(async () => ({ allowed: true })),
    recordRequest: jest.fn(async () => undefined),
    recordChannelRequest: jest.fn(async () => undefined),
  };
  const channels = {
    getChannelById: jest.fn(async () => ({
      connectionStatus: 'connected',
      platformAccountId: 'acc',
      metadata: {},
    })),
    getAccessToken: jest.fn(async () => 'tok'),
  };
  const svc = new PostService(
    channels as any,
    { getPublisher: () => publisher } as any,
    rate as any,
    { getJob: jest.fn(), add: jest.fn() } as any,
    { add: jest.fn(async () => undefined) } as any,
    {
      has: () => true,
      get: () => ({
        pollingProfile: {
          schedulePerContentType: { post: ['1h'] },
          defaultContentType: 'post',
        },
      }),
    } as any,
    { emit: jest.fn() } as any,
    { syncPost: jest.fn(async () => undefined) } as any,
    { syncFromPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
    { send: jest.fn(async () => undefined) } as any,
  );
  return { svc, publisher };
}

const row = (over: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  content: 'shared caption',
  mediaItems: [{ url: 'https://cdn/shared.jpg', type: 'image' }],
  platformContent: {},
  targets: [
    { channelId: '7', platform: 'instagram', status: 'draft' },
    { channelId: '9', platform: 'linkedin', status: 'draft' },
  ],
  metadata: {},
  publishedAt: null,
  ...over,
});

/** What each channel was sent, in the order of its target. */
const sent = (publisher: any) =>
  publisher.publish.mock.calls.map(([arg]: any[]) => ({
    content: arg.content,
    media: (arg.mediaItems ?? []).map((m: any) => m.url),
  }));

beforeEach(() => {
  updates = [];
  inserts = [];
  jest.clearAllMocks();
});

describe("PostService.publishPost — a channel's own caption and media", () => {
  it("sends a composer post's per-channel override on a SCHEDULED publish", async () => {
    // The composer stores each channel under `overrides`. The scheduled
    // path read only the flat legacy keys, so Instagram's own caption and
    // file fell back to the shared post.
    currentRow = row({
      platformContent: {
        instagram: {
          inheritsFromBase: false,
          overrides: {
            text: 'instagram caption',
            mediaItems: [{ url: 'https://cdn/ig.jpg', type: 'image' }],
          },
          platformSpecific: {},
        },
        linkedin: { inheritsFromBase: true, overrides: {}, platformSpecific: {} },
      },
    });
    const { svc, publisher } = make();
    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });
    expect(sent(publisher)).toEqual([
      { content: 'instagram caption', media: ['https://cdn/ig.jpg'] },
      { content: 'shared caption', media: ['https://cdn/shared.jpg'] },
    ]);
  });

  it('still reads the legacy flat shape', async () => {
    currentRow = row({
      platformContent: {
        instagram: {
          text: 'legacy caption',
          mediaItems: [{ url: 'https://cdn/legacy.jpg', type: 'image' }],
        },
      },
    });
    const { svc, publisher } = make();
    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });
    expect(sent(publisher)[0]).toEqual({
      content: 'legacy caption',
      media: ['https://cdn/legacy.jpg'],
    });
  });
});
