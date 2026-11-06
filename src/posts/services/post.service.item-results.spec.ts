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
import { PartialPublishError } from '../publishers/base.publisher';

/**
 * The scheduled / legacy publish path. Its targets come from the stored row,
 * so per-item results (one Pin per image) ride on the target itself: they
 * are handed to the publisher on a retry, and stored from both a success and
 * a part-way failure.
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
  );
  return { svc, publisher };
}

const A = { mediaUrl: 'https://cdn.test/a.jpg', platformPostId: 'pin-a' };
const B = { mediaUrl: 'https://cdn.test/b.jpg', platformPostId: 'pin-b' };

const row = (target: any) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'failed',
  content: 'hi',
  jobId: null,
  targets: [
    { channelId: '1', platform: 'pinterest', status: 'failed', ...target },
  ],
});

beforeEach(() => {
  updates = [];
  jest.clearAllMocks();
});

const finalTarget = () => updates[updates.length - 1].targets[0];

describe('PostService.publishPost - per-item results', () => {
  it('hands a retry the items that already went out', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });
    currentRow = row({ itemResults: [A] });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(publisher.publish.mock.calls[0][0].previousItemResults).toEqual([A]);
  });

  it('sends none on a first publish', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({ platformPostId: 'p' });
    currentRow = row({ status: 'draft' });
    await svc.publishPost('p1', 'w1', 'u1');
    expect('previousItemResults' in publisher.publish.mock.calls[0][0]).toBe(
      false,
    );
  });

  it('stores every item on success, the first as the post id', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockResolvedValue({
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });
    currentRow = row({});
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget()).toMatchObject({
      status: 'published',
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });
  });

  it('stores the items that went out when it failed part-way', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValue(
      new PartialPublishError('Rate limited', [A]),
    );
    currentRow = row({});
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget()).toMatchObject({
      status: 'failed',
      errorMessage: 'Rate limited',
      itemResults: [A],
    });
  });

  it('keeps earlier items when a retry fails outright', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValue(new Error('still down'));
    currentRow = row({ itemResults: [A] });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(finalTarget().itemResults).toEqual([A]);
  });
});
