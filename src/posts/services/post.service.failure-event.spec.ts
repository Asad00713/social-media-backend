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
 * A failed publish on the scheduled path names its cause the way Publish now
 * does (one shared classifier, `errorCode` per target), and the
 * `post.status.changed` event says who should hear about it (the post's
 * author) and whether anyone was waiting on it (`trigger`), so the app can
 * toast the author once and never twice.
 */
function make(opts: { channelAllowed?: boolean } = {}) {
  const publisher = { publish: jest.fn() };
  const emitter = { emit: jest.fn() };
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
      checkChannelRateLimit: jest.fn(async () =>
        opts.channelAllowed === false
          ? { allowed: false, retryAfterMs: 120_000 }
          : { allowed: true },
      ),
      recordRequest: jest.fn(async () => undefined),
      recordChannelRequest: jest.fn(async () => undefined),
    } as any,
    { getJob: jest.fn(async () => null), add: jest.fn() } as any,
    { add: jest.fn(async () => undefined) } as any,
    { has: () => false, get: () => undefined } as any,
    emitter as any,
    {
      syncPost: jest.fn(async () => undefined),
      loadPostLinks: jest.fn(async () => []),
      deleteEventsForLinks: jest.fn(async () => undefined),
    } as any,
    { syncFromPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
    { send: jest.fn() } as any, // PostReminderService
  );
  return { svc, publisher, emitter };
}

const row = (target: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'author-1',
  status: 'scheduled',
  content: 'hi',
  jobId: null,
  targets: [
    { channelId: '1', platform: 'instagram', status: 'scheduled', ...target },
  ],
});

/** The last `post.status.changed` payload: the outcome, not "publishing". */
const lastEvent = (emitter: { emit: jest.Mock }) => {
  const calls = emitter.emit.mock.calls.filter(
    (c) => c[1] === 'post.status.changed',
  );
  return calls[calls.length - 1][2];
};

const finalTarget = () => updates[updates.length - 1].targets[0];

beforeEach(() => {
  updates = [];
  jest.clearAllMocks();
});

describe('PostService.publishPost - failure cause and event routing', () => {
  it('a scheduled failure stores the classified code on the target', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValue(
      new Error('Video is longer than 90 seconds.'),
    );
    currentRow = row();
    await svc.publishPost('p1', 'w1', 'author-1', { triggeredBy: 'scheduler' });
    expect(finalTarget()).toMatchObject({
      status: 'failed',
      errorCode: 'media_invalid',
      errorMessage: 'Video is longer than 90 seconds.',
    });
  });

  it('the event carries the code per target, the author and trigger "scheduled"', async () => {
    const { svc, publisher, emitter } = make();
    publisher.publish.mockRejectedValue(
      new Error('The access token has expired'),
    );
    currentRow = row();
    await svc.publishPost('p1', 'w1', 'author-1', { triggeredBy: 'scheduler' });
    const ev = lastEvent(emitter);
    expect(ev).toMatchObject({
      postId: 'p1',
      status: 'failed',
      previousStatus: 'publishing',
      triggeredBy: 'scheduler',
      authorId: 'author-1',
      trigger: 'scheduled',
    });
    expect(ev.targets[0]).toMatchObject({
      platform: 'instagram',
      status: 'failed',
      errorCode: 'auth_failed',
      errorMessage: 'The access token has expired',
    });
  });

  it('the "publishing" event already names the author and the trigger', async () => {
    const { svc, publisher, emitter } = make();
    publisher.publish.mockResolvedValue({ platformPostId: 'ig1' });
    currentRow = row();
    await svc.publishPost('p1', 'w1', 'author-1', { triggeredBy: 'scheduler' });
    const first = emitter.emit.mock.calls.find(
      (c) => c[1] === 'post.status.changed',
    )![2];
    expect(first).toMatchObject({
      status: 'publishing',
      authorId: 'author-1',
      trigger: 'scheduled',
    });
  });

  it('Publish now by someone else: trigger "publish_now", the author stays the author', async () => {
    const { svc, publisher, emitter } = make();
    publisher.publish.mockRejectedValue(new Error('Status is a duplicate.'));
    currentRow = { ...row(), status: 'failed' };
    await svc.publishPost('p1', 'w1', 'teammate-2');
    expect(lastEvent(emitter)).toMatchObject({
      triggeredBy: 'user',
      triggeredByUserId: 'teammate-2',
      authorId: 'author-1',
      trigger: 'publish_now',
    });
    expect(lastEvent(emitter).targets[0].errorCode).toBe('content_rejected');
  });

  it('an automated publish can say it was not pressed (a drip occurrence)', async () => {
    const { svc, publisher, emitter } = make();
    publisher.publish.mockRejectedValue(new Error('Wat'));
    currentRow = { ...row(), status: 'draft' };
    await svc.publishPost('p1', 'w1', 'author-1', {
      onPaused: 'hold',
      trigger: 'scheduled',
    });
    expect(lastEvent(emitter)).toMatchObject({
      triggeredBy: 'user',
      trigger: 'scheduled',
    });
    expect(finalTarget().errorCode).toBe('permanent');
  });

  it('our own rate limit fails the target as rate_limited', async () => {
    const { svc, publisher } = make({ channelAllowed: false });
    currentRow = row();
    await svc.publishPost('p1', 'w1', 'author-1', { triggeredBy: 'scheduler' });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(finalTarget()).toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
    });
  });

  it('a retry that goes out drops the old failure from the target', async () => {
    const { svc, publisher, emitter } = make();
    publisher.publish.mockResolvedValue({ platformPostId: 'ig1' });
    currentRow = {
      ...row({
        status: 'failed',
        errorCode: 'transient',
        errorMessage: 'socket hang up',
      }),
      status: 'failed',
    };
    await svc.publishPost('p1', 'w1', 'author-1');
    expect(finalTarget().status).toBe('published');
    expect(finalTarget().errorCode).toBeUndefined();
    expect(finalTarget().errorMessage).toBeUndefined();
    expect(lastEvent(emitter).targets[0].errorCode).toBeUndefined();
  });

  it('a new failure replaces the code of the last one', async () => {
    const { svc, publisher } = make();
    publisher.publish.mockRejectedValue(new Error('Tweet text is too long'));
    currentRow = {
      ...row({ status: 'failed', errorCode: 'transient', errorMessage: 'x' }),
      status: 'failed',
    };
    await svc.publishPost('p1', 'w1', 'author-1');
    expect(finalTarget()).toMatchObject({
      errorCode: 'content_rejected',
      errorMessage: 'Tweet text is too long',
    });
  });
});
