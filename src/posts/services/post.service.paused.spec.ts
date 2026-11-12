/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

let currentRow: any;
let updates: any[];
let inserts: any[];
/** Answers to successive paused-channel lookups; [] once exhausted. */
let pausedAnswers: any[][];

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
  jest.clearAllMocks();
});

describe('PostService.publishPost on paused channels', () => {
  it('a scheduled job for a fully paused post holds every target and changes nothing else', async () => {
    currentRow = row();
    pausedAnswers = [PAUSED_BOTH, PAUSED_BOTH];
    const { svc, publisher, queue } = make();

    await svc.publishPost('p1', 'w1', 'u1', { triggeredBy: 'scheduler' });

    expect(publisher.publish).not.toHaveBeenCalled();
    // Never flipped to publishing, never failed: no status written at all.
    expect(statusWrites()).toEqual([]);
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
