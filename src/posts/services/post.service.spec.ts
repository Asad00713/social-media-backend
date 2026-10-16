/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

let currentRow: any;
let updates: any[];

/** A `where()` result that can be awaited, `.returning()`'d or `.limit()`'d. */
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

function make() {
  const jobs = new Map<string, boolean>();
  const removed: string[] = [];
  const publishingQueue = {
    getJob: jest.fn(async (id: string) =>
      jobs.has(id)
        ? {
            remove: async () => {
              removed.push(id);
            },
          }
        : null,
    ),
    add: jest.fn(async (_n: string, _d: any, o: any) => ({ id: o.jobId })),
  };
  const publisher = {
    publish: jest.fn(async () => ({
      platformPostId: 'new-id',
      platformPostUrl: 'https://x/new',
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
  const calendar = {
    syncPost: jest.fn(async () => undefined),
    loadPostLinks: jest.fn(async () => []),
    deleteEventsForLinks: jest.fn(async () => undefined),
  };
  const svc = new PostService(
    channels as any,
    { getPublisher: () => publisher } as any,
    rate as any,
    publishingQueue as any,
    { add: jest.fn(async () => undefined) } as any,
    { has: () => false, get: () => undefined } as any,
    { emit: jest.fn() } as any,
    calendar as any,
    { syncFromPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
  );
  return { svc, jobs, removed, publishingQueue, publisher, rate };
}

const baseRow = (over: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  content: 'hi',
  jobId: null,
  targets: [],
  ...over,
});

beforeEach(() => {
  updates = [];
  jest.clearAllMocks();
});

describe('PostService cancels BOTH publish jobs when a post is moved or deleted', () => {
  it('updatePost({scheduledAt}) removes composer-publish-<id> even when job_id is null', async () => {
    const { svc, jobs, removed } = make();
    jobs.set('composer-publish-p1', true);
    currentRow = baseRow({ jobId: null });
    await svc.updatePost('p1', 'w1', 'u1', {
      scheduledAt: new Date(Date.now() + 3_600_000),
    } as any);
    expect(removed).toEqual(['composer-publish-p1']);
  });

  it('updatePost({scheduledAt}) removes the job_id job and the composer job', async () => {
    const { svc, jobs, removed } = make();
    jobs.set('composer-publish-p1', true);
    jobs.set('post-p1-1', true);
    currentRow = baseRow({ jobId: 'post-p1-1' });
    await svc.updatePost('p1', 'w1', 'u1', {
      scheduledAt: new Date(Date.now() + 3_600_000),
    } as any);
    expect(removed.sort()).toEqual(['composer-publish-p1', 'post-p1-1']);
  });

  it('deletePost removes both', async () => {
    const { svc, jobs, removed } = make();
    jobs.set('composer-publish-p1', true);
    jobs.set('post-p1-1', true);
    currentRow = baseRow({ jobId: 'post-p1-1' });
    await svc.deletePost('p1', 'w1', 'u1');
    expect(removed.sort()).toEqual(['composer-publish-p1', 'post-p1-1']);
  });

  it('deletePost removes the composer job when job_id is null', async () => {
    const { svc, jobs, removed } = make();
    jobs.set('composer-publish-p1', true);
    currentRow = baseRow({ jobId: null });
    await svc.deletePost('p1', 'w1', 'u1');
    expect(removed).toEqual(['composer-publish-p1']);
  });
});

describe('PostService.publishPost retry', () => {
  const published = {
    channelId: '1',
    platform: 'twitter',
    status: 'published',
    platformPostId: 'old-1',
    publishedAt: '2026-10-01T00:00:00.000Z',
  };
  const failed = {
    channelId: '2',
    platform: 'facebook',
    status: 'failed',
    errorMessage: 'boom',
  };
  const firstPublishedAt = new Date('2026-10-01T00:00:00.000Z');

  const retryRow = () =>
    baseRow({
      status: 'partially_published',
      publishedAt: firstPublishedAt,
      targets: [published, failed],
    });

  it('publishes only the failed target and leaves the published one untouched', async () => {
    const { svc, publisher, rate } = make();
    currentRow = retryRow();
    await svc.publishPost('p1', 'w1', 'u1');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(rate.checkRateLimit).toHaveBeenCalledWith('facebook');
    const final = updates[updates.length - 1];
    expect(final.status).toBe('published');
    expect(final.targets[0]).toEqual(published);
    expect(final.targets[1]).toMatchObject({
      status: 'published',
      platformPostId: 'new-id',
    });
  });

  it('a retry that succeeds keeps the time the post first went out, so it does not move on the calendar', async () => {
    const { svc } = make();
    currentRow = retryRow();
    await svc.publishPost('p1', 'w1', 'u1');
    const final = updates[updates.length - 1];
    expect(final.status).toBe('published');
    expect(final.publishedAt ?? firstPublishedAt).toEqual(firstPublishedAt);
  });

  it('a retry that succeeds clears the old "some channels failed" error', async () => {
    const { svc } = make();
    currentRow = { ...retryRow(), lastError: 'Some channels failed to publish' };
    await svc.publishPost('p1', 'w1', 'u1');
    const final = updates[updates.length - 1];
    expect(final.lastError).toBeNull();
  });

  it('stays partially_published and keeps the original publishedAt when the retry fails again', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValueOnce(new Error('still down'));
    currentRow = retryRow();
    await svc.publishPost('p1', 'w1', 'u1');
    const final = updates[updates.length - 1];
    expect(final.status).toBe('partially_published');
    expect(final.targets[0]).toEqual(published);
    expect(final.targets[1]).toMatchObject({
      status: 'failed',
      errorMessage: 'still down',
    });
    // Not wiped, not overwritten: either absent from the update or unchanged.
    expect(final.publishedAt ?? firstPublishedAt).toEqual(firstPublishedAt);
    expect(updates.every((u) => u.publishedAt !== null)).toBe(true);
  });

  it('first publish (all pending) still publishes every target and stamps publishedAt', async () => {
    const { svc, publisher } = make();
    currentRow = baseRow({
      status: 'scheduled',
      targets: [
        { channelId: '1', platform: 'twitter', status: 'draft' },
        { channelId: '2', platform: 'facebook', status: 'draft' },
      ],
    });
    await svc.publishPost('p1', 'w1', 'u1');
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    const final = updates[updates.length - 1];
    expect(final.status).toBe('published');
    expect(final.publishedAt).toBeInstanceOf(Date);
  });
});
