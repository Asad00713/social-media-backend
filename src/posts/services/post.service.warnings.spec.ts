/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

let currentRow: any;
let updates: any[];

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
  insert: jest.fn(() => ({ values: async () => undefined })),
  delete: jest.fn(() => ({ where: async () => undefined })),
  execute: jest.fn(async () => undefined),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PostService } from './post.service';

/**
 * D4 on the scheduled / legacy publish path: a soft step that failed after
 * the post went live (`result.metadata.*Warning`) is stored on the target as
 * `warnings`, so the post reads "published with issues" instead of
 * silently missing the setting.
 */
function make() {
  const publisher = { publish: jest.fn() };
  const svc = new PostService(
    {
      getChannelById: jest.fn(async () => ({
        connectionStatus: 'connected',
        platformAccountId: 'acc',
        metadata: {},
      })),
      getAccessToken: jest.fn(async () => 'tok'),
    } as any,
    { getPublisher: () => publisher } as any,
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
  return { svc, publisher };
}

const row = (target: any) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'failed',
  content: 'hi',
  jobId: null,
  targets: [
    { channelId: '1', platform: 'instagram', status: 'failed', ...target },
  ],
});

beforeEach(() => {
  updates = [];
  jest.clearAllMocks();
});

const finalTarget = () => updates[updates.length - 1].targets[0];

describe('PostService.publishPost - publish warnings', () => {
  it('stores each soft-step failure on the published target', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({
      platformPostId: 'ig1',
      metadata: {
        firstCommentWarning: 'rate limited',
        coverWarning: 'cover too large',
        firstCommentId: undefined,
      },
    });
    currentRow = row({});
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget()).toMatchObject({
      status: 'published',
      warnings: [
        'First comment was not posted: rate limited',
        'Cover was not set: cover too large',
      ],
    });
  });

  it('stores no warnings key on a clean publish', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({ platformPostId: 'ig1' });
    currentRow = row({});
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget().warnings).toBeUndefined();
  });

  it('drops a stale list when the retry publishes clean', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({ platformPostId: 'ig1' });
    currentRow = row({ warnings: ['Cover was not set: old'] });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget().warnings).toBeUndefined();
  });

  it('never puts a warning on a failed target', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValue(new Error('down'));
    currentRow = row({ warnings: ['Cover was not set: old'] });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget()).toMatchObject({ status: 'failed' });
    expect(finalTarget().warnings).toBeUndefined();
  });
});
