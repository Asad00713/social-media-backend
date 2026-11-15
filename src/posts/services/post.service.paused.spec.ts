/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { dripPosts } from '../../drizzle/schema/drips.schema';

let currentRow: any;
let updates: any[];
let inserts: any[];
/** Answers to successive paused-channel lookups; [] once exhausted. */
let pausedAnswers: any[][];
/** Writes to tables other than posts (the drip sync). */
let otherWrites: Array<{ table: unknown; set: any }>;

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
    from: (table: unknown) => ({
      where: () =>
        settle(() =>
          table === socialMediaChannels
            ? (pausedAnswers.shift() ?? [])
            : [currentRow],
        ),
    }),
  })),
  update: jest.fn((table: unknown) => ({
    set: (v: any) => {
      if (table === dripPosts) {
        otherWrites.push({ table, set: v });
        return { where: () => settle(() => []) };
      }
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
      platformPostId: 'x-1',
      platformPostUrl: 'https://x/1',
    })),
  };
  const queue = {
    getJob: jest.fn(async () => null),
    add: jest.fn(async (_n: string, _d: unknown, o: { jobId: string }) => ({
      id: o.jobId,
    })),
  };
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
    queue as any,
    { add: jest.fn(async () => undefined) } as any,
    { has: () => false } as any,
    { emit: jest.fn() } as any,
    { syncPost: jest.fn(async () => undefined) } as any,
    { syncFromPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
    { send: jest.fn(async () => undefined) } as any,
  );
  return { svc, publisher, queue };
}

const row = (over: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  // Its time has come: that is when a publish job runs.
  scheduledAt: new Date(Date.now() - 60_000),
  content: 'hello',
  mediaItems: [],
  platformContent: {},
  targets: [
    { channelId: '7', platform: 'bluesky', status: 'draft' },
    { channelId: '9', platform: 'mastodon', status: 'draft' },
  ],
  metadata: {},
  publishedAt: null,
  ...over,
});

const PAUSED_7 = [{ id: 7, accountName: 'Bluesky', pausedAt: new Date() }];
const PAUSED_BOTH = [
  ...PAUSED_7,
  { id: 9, accountName: 'Mastodon', pausedAt: new Date() },
];

const statusWrites = () =>
  updates.filter((u) => u.status !== undefined).map((u) => u.status);
const lastTargets = () =>
  [...updates].reverse().find((u) => u.targets)?.targets as any[];

beforeEach(() => {
  updates = [];
  inserts = [];
  pausedAnswers = [];
  otherWrites = [];
  jest.clearAllMocks();
});

describe('PostService.publishPost on paused channels', () => {
  it('a scheduled job for a fully paused post holds every target and changes nothing else', async () => {
    currentRow = row();
    pausedAnswers = [PAUSED_BOTH, PAUSED_BOTH];
    const { svc, publisher, queue } = make();

    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(publisher.publish).not.toHaveBeenCalled();
    // Never flipped to publishing, never failed: it stays scheduled, at its
    // own time.
    expect(statusWrites()).toEqual(['scheduled']);
    expect(updates[0].scheduledAt).toBeUndefined();
    const targets = lastTargets();
    expect(targets).toHaveLength(2);
    for (const t of targets) {
      expect(t.status).toBe('draft');
      expect(t.heldReason).toBe('channel_paused');
      expect(typeof t.heldAt).toBe('string');
      expect(t.errorMessage).toBeUndefined();
    }
    expect(inserts.filter((i) => i.action === 'held')).toHaveLength(2);
    // Still paused on the re-check: nothing re-enqueued.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not throw for a held post (no retry is burned)', async () => {
    currentRow = row();
    pausedAnswers = [PAUSED_BOTH, PAUSED_BOTH];
    const { svc } = make();
    await expect(
      svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' }),
    ).resolves.toBeDefined();
  });

  it('a mixed post publishes the live channel, holds the paused one, stays scheduled', async () => {
    currentRow = row();
    pausedAnswers = [PAUSED_7, PAUSED_7];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(statusWrites()).toEqual(['publishing', 'scheduled']);
    const final = updates.find((u) => u.status === 'scheduled');
    const [held, live] = final.targets;
    expect(held).toMatchObject({
      channelId: '7',
      status: 'draft',
      heldReason: 'channel_paused',
    });
    expect(live).toMatchObject({ channelId: '9', status: 'published' });
    expect(final.lastError).toBeNull();
  });

  it('refuses a person publishing now to a paused channel, before any write', async () => {
    currentRow = row({ status: 'draft' });
    pausedAnswers = [PAUSED_7];
    const { svc, publisher } = make();

    const err: any = await svc
      .publishPost('p1', 'w1', 'u1', { triggeredBy: 'user' })
      .catch((e: unknown) => e);

    expect(err.getResponse()).toMatchObject({
      statusCode: 400,
      code: 'CHANNEL_PAUSED',
    });
    expect(err.getResponse().message).toContain('Bluesky');
    expect(updates).toEqual([]);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('a resume (heldOnly) publishes the held target, clears its marker, and leaves a failed one alone', async () => {
    currentRow = row({
      targets: [
        {
          channelId: '7',
          platform: 'bluesky',
          status: 'draft',
          heldAt: '2026-11-12T09:00:00.000Z',
          heldReason: 'channel_paused',
        },
        {
          channelId: '9',
          platform: 'mastodon',
          status: 'failed',
          errorMessage: 'boom',
        },
      ],
    });
    pausedAnswers = [[]];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', {
      triggeredBy: 'scheduler',
      heldOnly: true,
    });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [sent, failed] = lastTargets();
    expect(sent.status).toBe('published');
    expect('heldAt' in sent).toBe(false);
    expect('heldReason' in sent).toBe(false);
    expect(failed).toEqual({
      channelId: '9',
      platform: 'mastodon',
      status: 'failed',
      errorMessage: 'boom',
    });
    expect(statusWrites().at(-1)).toBe('partially_published');
  });

  it('re-enqueues at once when the channel was resumed while the job was holding it', async () => {
    currentRow = row();
    // Paused when read, no longer paused on the re-check after the write.
    pausedAnswers = [PAUSED_BOTH, []];
    const { svc, queue } = make();

    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(queue.add).toHaveBeenCalledWith(
      'publish-post',
      { postId: 'p1', heldOnly: true },
      expect.objectContaining({ delay: 0 }),
    );
  });

  it('a drip occurrence (onPaused: hold) on a paused channel is held, not refused, and becomes scheduled now', async () => {
    currentRow = row({ status: 'draft', scheduledAt: null });
    pausedAnswers = [PAUSED_BOTH, PAUSED_BOTH];
    const { svc, publisher } = make();

    const before = Date.now();
    const result = await svc.publishPost('p1', 'w1', 'u1', {
      onPaused: 'hold',
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.status).toBe('scheduled');
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('scheduled');
    expect(updates[0].scheduledAt.getTime()).toBeGreaterThanOrEqual(before);
    for (const t of updates[0].targets) {
      expect(t).toMatchObject({
        status: 'draft',
        heldReason: 'channel_paused',
      });
    }
  });

  it('a mixed drip occurrence publishes the live channel and stays scheduled from now', async () => {
    currentRow = row({ status: 'draft', scheduledAt: null });
    pausedAnswers = [PAUSED_7, PAUSED_7];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', { onPaused: 'hold' });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const final = updates.find((u) => u.status === 'scheduled');
    expect(final.scheduledAt).toBeInstanceOf(Date);
    expect(final.targets[0].heldReason).toBe('channel_paused');
  });

  it('a held drip occurrence that goes out on resume updates its drip post', async () => {
    currentRow = row({
      metadata: { dripCampaignId: 'c1', dripPostId: 'dp1' },
      targets: [
        {
          channelId: '7',
          platform: 'bluesky',
          status: 'draft',
          heldAt: '2026-11-12T09:00:00.000Z',
          heldReason: 'channel_paused',
        },
      ],
    });
    pausedAnswers = [[]];
    const { svc } = make();
    await svc.publishPost('p1', 'w1', 'u1', {
      triggeredBy: 'scheduler',
      heldOnly: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(otherWrites).toHaveLength(1);
    expect(otherWrites[0].set.status).toBe('published');
  });

  it('while still held, the drip post is not touched', async () => {
    currentRow = row({ metadata: { dripCampaignId: 'c1', dripPostId: 'dp1' } });
    pausedAnswers = [PAUSED_7, PAUSED_7];
    const { svc } = make();
    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });
    await new Promise((r) => setImmediate(r));
    expect(otherWrites).toEqual([]);
  });

  it('without onPaused, a person publishing now is still refused', async () => {
    currentRow = row({ status: 'draft', scheduledAt: null });
    pausedAnswers = [PAUSED_7];
    const { svc } = make();
    await expect(svc.publishPost('p1', 'w1', 'u1')).rejects.toMatchObject({
      response: { code: 'CHANNEL_PAUSED' },
    });
  });

  it('a post with no paused channel publishes exactly as before', async () => {
    currentRow = row();
    const { svc, publisher, queue } = make();
    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(statusWrites()).toEqual(['publishing', 'published']);
    expect(queue.add).not.toHaveBeenCalled();
    expect(lastTargets().every((t) => !('heldAt' in t))).toBe(true);
  });
});

describe('PostService.publishPost on disconnected channels', () => {
  const DISCONNECTED_7 = [
    {
      id: 7,
      accountName: 'Bluesky',
      pausedAt: null,
      connectionStatus: 'disconnected',
    },
  ];

  it('a scheduled job holds the disconnected target as disconnected, publishes the rest', async () => {
    currentRow = row();
    pausedAnswers = [DISCONNECTED_7, DISCONNECTED_7];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const targets = lastTargets();
    const held = targets.find((t) => t.channelId === '7');
    expect(held.heldReason).toBe('channel_disconnected');
    expect(typeof held.heldAt).toBe('string');
    expect(held.status).toBe('draft');
    expect(targets.find((t) => t.channelId === '9').status).toBe('published');
    // Part still waits: the post stays scheduled.
    expect(statusWrites().at(-1)).toBe('scheduled');
  });

  it('Publish now names the disconnected channel (CHANNEL_DISCONNECTED), before a pause', async () => {
    currentRow = row({ status: 'draft' });
    pausedAnswers = [
      [
        ...DISCONNECTED_7,
        { id: 9, accountName: 'Mastodon', pausedAt: new Date() },
      ],
    ];
    const { svc, publisher } = make();

    const err = await svc
      .publishPost('p1', 'w1', 'u1', { triggeredBy: 'user' })
      .catch((e: any) => e);
    expect(err.getResponse()).toMatchObject({
      code: 'CHANNEL_DISCONNECTED',
      message: expect.stringContaining('Disconnected: Bluesky'),
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('a missed release fails the held target instead of publishing it late', async () => {
    const heldAt = new Date(Date.now() - 86_400_000).toISOString();
    currentRow = row({
      scheduledAt: new Date(Date.now() - 86_400_000),
      targets: [
        {
          channelId: '7',
          platform: 'bluesky',
          status: 'draft',
          heldAt,
          heldReason: 'channel_disconnected',
        },
        { channelId: '9', platform: 'mastodon', status: 'published' },
      ],
    });
    pausedAnswers = [[]];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', {
      triggeredBy: 'scheduler',
      heldOnly: true,
      missedHeld: true,
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    const t7 = lastTargets().find((t) => t.channelId === '7');
    expect(t7.status).toBe('failed');
    expect(t7.errorMessage).toMatch(/time passed while the channel was disconnected/);
    expect('heldAt' in t7).toBe(false);
    expect(statusWrites().at(-1)).toBe('partially_published');
  });

  it('without missedHeld the held target (channel back) is published', async () => {
    currentRow = row({
      targets: [
        {
          channelId: '7',
          platform: 'bluesky',
          status: 'draft',
          heldAt: new Date().toISOString(),
          heldReason: 'channel_disconnected',
        },
      ],
    });
    pausedAnswers = [[], []];
    const { svc, publisher } = make();

    await svc.publishPost('p1', 'w1', 'u1', {
      triggeredBy: 'scheduler',
      heldOnly: true,
    });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(lastTargets()[0].status).toBe('published');
    expect('heldReason' in lastTargets()[0]).toBe(false);
  });
});
