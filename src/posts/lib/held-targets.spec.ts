/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- loosely typed test doubles */
import {
  HELD_REASON,
  enqueueHeldPost,
  holdTarget,
  isHeld,
  isJobPending,
  releaseTarget,
  resumeDelayMs,
} from './held-targets';
import type { PostTarget } from '../../drizzle/schema/posts.schema';

const NOW = new Date('2026-11-12T12:00:00Z');

const target = (over: Partial<PostTarget> = {}): PostTarget =>
  ({
    channelId: '7',
    platform: 'bluesky',
    status: 'draft',
    publishStatus: 'queued',
    ...over,
  }) as PostTarget;

describe('holdTarget / releaseTarget', () => {
  it('marks held without touching either status field', () => {
    const held = holdTarget(target(), NOW);
    expect(held).toMatchObject({
      status: 'draft',
      publishStatus: 'queued',
      heldAt: NOW.toISOString(),
      heldReason: HELD_REASON,
    });
    expect(isHeld(held)).toBe(true);
    expect(isHeld(target())).toBe(false);
  });

  it('keeps the first hold time when held again', () => {
    const first = holdTarget(target(), NOW);
    const again = holdTarget(first, new Date('2026-11-13T00:00:00Z'));
    expect(again.heldAt).toBe(NOW.toISOString());
  });

  it('release strips only the hold markers', () => {
    const released = releaseTarget(holdTarget(target(), NOW));
    expect(released).toEqual(target());
    expect('heldAt' in released).toBe(false);
    const plain = target();
    expect(releaseTarget(plain)).toBe(plain);
  });
});

describe('resumeDelayMs', () => {
  it('waits for a time still ahead, goes now for one that passed', () => {
    expect(resumeDelayMs(new Date(NOW.getTime() + 60_000), NOW)).toBe(60_000);
    expect(resumeDelayMs(new Date(NOW.getTime() - 60_000), NOW)).toBe(0);
    expect(resumeDelayMs(null, NOW)).toBe(0);
  });
});

describe('isJobPending', () => {
  const queueWith = (state: string | null) => ({
    getJob: jest.fn(async () =>
      state ? { getState: async () => state } : undefined,
    ),
  });

  it.each(['waiting', 'delayed', 'active', 'prioritized'])(
    '%s is pending',
    async (state) => {
      expect(await isJobPending(queueWith(state) as any, 'j')).toBe(true);
    },
  );

  it.each(['completed', 'failed'])('%s is not', async (state) => {
    expect(await isJobPending(queueWith(state) as any, 'j')).toBe(false);
  });

  it('no id or no job is not pending', async () => {
    expect(await isJobPending(queueWith(null) as any, 'j')).toBe(false);
    expect(await isJobPending(queueWith('waiting') as any, null)).toBe(false);
  });
});

describe('enqueueHeldPost', () => {
  it('enqueues a heldOnly job with a colon-free id and records it on the row', async () => {
    const add = jest.fn(
      async (_n: string, _d: unknown, o: { jobId: string }) => ({
        id: o.jobId,
      }),
    );
    const set = jest.fn(() => ({ where: async () => undefined }));
    const db = { update: jest.fn(() => ({ set })) };

    const id = await enqueueHeldPost(
      { add } as any,
      db as any,
      { id: 'p1', scheduledAt: new Date(NOW.getTime() + 5_000) },
      NOW,
    );

    expect(id).toBe(`post-p1-resume-${NOW.getTime()}`);
    expect(id).not.toContain(':');
    expect(add).toHaveBeenCalledWith(
      'publish-post',
      { postId: 'p1', heldOnly: true },
      expect.objectContaining({ delay: 5_000, jobId: id, attempts: 3 }),
    );
    expect(set).toHaveBeenCalledWith({ jobId: id });
  });
});
