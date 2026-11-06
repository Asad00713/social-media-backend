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

function make(send = jest.fn(async () => undefined)) {
  const publisher = {
    publish: jest.fn(async () => ({
      platformPostId: 'li-1',
      platformPostUrl: 'https://li/1',
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
  const snapshots = { add: jest.fn(async () => undefined) };
  const reminders = { send };
  const svc = new PostService(
    channels as any,
    { getPublisher: () => publisher } as any,
    rate as any,
    { getJob: jest.fn(), add: jest.fn() } as any,
    snapshots as any,
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
    reminders as any,
  );
  return { svc, publisher, rate, snapshots, reminders };
}

const row = (over: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  content: 'shared caption',
  mediaItems: [{ url: 'https://cdn/a.jpg', type: 'image' }],
  platformContent: {
    instagram: {
      platformSpecific: { publishMode: 'remind', frameNote: 'Add the poll' },
    },
  },
  targets: [
    { channelId: '7', platform: 'instagram', status: 'draft' },
    { channelId: '9', platform: 'linkedin', status: 'draft' },
  ],
  metadata: {},
  publishedAt: null,
  ...over,
});

const finalTargets = () => updates.find((u) => u.targets)?.targets as any[];

beforeEach(() => {
  updates = [];
  inserts = [];
  jest.clearAllMocks();
});

describe('PostService.publishPost with "Remind me"', () => {
  it('reminds instead of publishing on the reminder channel, publishes the rest', async () => {
    currentRow = row();
    const { svc, publisher, reminders, rate } = make();
    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(reminders.send).toHaveBeenCalledTimes(1);
    expect(reminders.send).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      postId: 'p1',
      channelId: '7',
      content: {
        platform: 'instagram',
        caption: 'shared caption',
        mediaUrls: ['https://cdn/a.jpg'],
        note: 'Add the poll',
      },
    });
    // Only LinkedIn reached a publisher, and only it touched rate limits.
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(rate.checkRateLimit).toHaveBeenCalledWith('linkedin');
  });

  it('stores the reminder channel as done, with when, and no platform post', async () => {
    currentRow = row();
    const { svc } = make();
    await svc.publishPost('p1', 'w1', 'u1');
    const [ig, li] = finalTargets();
    expect(ig).toMatchObject({ channelId: '7', status: 'published' });
    expect(typeof ig.reminderSentAt).toBe('string');
    expect(ig.platformPostId).toBeUndefined();
    expect(li).toMatchObject({ status: 'published', platformPostId: 'li-1' });
    expect(updates.find((u) => u.targets)?.status).toBe('published');
  });

  it('records the reminder in the history and enqueues no metrics for it', async () => {
    currentRow = row();
    const { svc, snapshots } = make();
    await svc.publishPost('p1', 'w1', 'u1');
    expect(inserts).toContainEqual(
      expect.objectContaining({
        action: 'reminder_sent',
        channelId: 7,
        newStatus: 'published',
      }),
    );
    // One trail, LinkedIn's.
    expect(snapshots.add).toHaveBeenCalledTimes(1);
    expect((snapshots.add.mock.calls[0] as any[])[1].channelId).toBe(9);
  });

  it('a reminder that cannot be sent fails that channel, not the others', async () => {
    currentRow = row();
    const { svc, publisher } = make(
      jest.fn(async () => {
        throw new Error('db down');
      }),
    );
    await svc.publishPost('p1', 'w1', 'u1');
    const [ig, li] = finalTargets();
    expect(ig).toMatchObject({
      status: 'failed',
      errorMessage: 'Could not send your reminder: db down',
    });
    expect(li.status).toBe('published');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.targets)?.status).toBe('partially_published');
  });

  it('a retry does not remind twice', async () => {
    currentRow = row({
      status: 'failed',
      targets: [
        {
          channelId: '7',
          platform: 'instagram',
          status: 'published',
          reminderSentAt: '2026-10-15T04:30:00.000Z',
        },
        { channelId: '9', platform: 'linkedin', status: 'failed' },
      ],
    });
    const { svc, reminders } = make();
    await svc.publishPost('p1', 'w1', 'u1');
    expect(reminders.send).not.toHaveBeenCalled();
  });

  it('without the mode nothing changes: every channel publishes', async () => {
    currentRow = row({ platformContent: {} });
    const { svc, publisher, reminders } = make();
    await svc.publishPost('p1', 'w1', 'u1');
    expect(reminders.send).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});
