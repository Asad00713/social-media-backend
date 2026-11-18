/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- loosely typed test doubles */
import {
  HELD_REASON,
  HELD_REASON_DISCONNECTED,
  HELD_REASON_RATE_LIMITED,
  RATE_LIMIT_MIN_DELAY_MS,
  enqueueHeldPost,
  holdRateLimited,
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

/**
 * A rate limit is the third reason a target is held, and the only one that
 * releases itself: the limiter says exactly when the window reopens, so the
 * post is enqueued for that moment rather than waiting on a user action.
 *
 * Before this existed the publish path marked the target `failed` and threw
 * away the reopening time it had just computed, so a customer had to notice
 * and resend by hand.
 */
describe('holdRateLimited', () => {
  it('holds without touching either status field', () => {
    const held = holdRateLimited(target(), NOW);
    expect(held).toMatchObject({
      status: 'draft',
      publishStatus: 'queued',
      heldAt: NOW.toISOString(),
      heldReason: HELD_REASON_RATE_LIMITED,
    });
  });

  /**
   * The reason a plain holdTarget() call is wrong here. holdTarget REWRITES
   * the reason, and `channel_paused` / `channel_disconnected` are released by
   * a user action — resuming or reconnecting. Overwriting one with
   * `rate_limited` would make the post release itself on a timer and publish
   * to a channel the user had deliberately paused.
   */
  it.each([
    ['paused', HELD_REASON],
    ['disconnected', HELD_REASON_DISCONNECTED],
  ])('leaves a %s hold alone rather than downgrading it', (_label, reason) => {
    const already = holdTarget(target(), NOW, reason);
    const after = holdRateLimited(already, new Date('2026-11-13T00:00:00Z'));
    expect(after.heldReason).toBe(reason);
    expect(after.heldAt).toBe(NOW.toISOString());
  });

  it('keeps the first hold time when rate-limited twice', () => {
    const first = holdRateLimited(target(), NOW);
    const again = holdRateLimited(first, new Date('2026-11-13T00:00:00Z'));
    expect(again.heldAt).toBe(NOW.toISOString());
  });
});

describe('enqueueHeldPost with an explicit delay', () => {
  const post = { id: 'p1', scheduledAt: new Date('2026-11-12T18:00:00Z') };

  function queueSpy() {
    const add = jest.fn(async () => ({ id: 'job-1' }));
    return { add } as never;
  }
  const dbSpy = () =>
    ({
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    }) as never;

  it('uses the given delay instead of the post time', async () => {
    const queue = queueSpy();
    await enqueueHeldPost(queue, dbSpy(), post, NOW, { delayMs: 90 * 60_000 });
    expect((queue as never as { add: jest.Mock }).add.mock.calls[0][2].delay).toBe(
      90 * 60_000,
    );
  });

  /**
   * retryAfterMs can arrive as 0 (a window that has just reopened, or a
   * malformed Redis reply clamped at the source). Re-running immediately would
   * hit the same limit and hold again, in a tight loop.
   */
  it('never enqueues below the floor', async () => {
    const queue = queueSpy();
    await enqueueHeldPost(queue, dbSpy(), post, NOW, { delayMs: 0 });
    expect(
      (queue as never as { add: jest.Mock }).add.mock.calls[0][2].delay,
    ).toBe(RATE_LIMIT_MIN_DELAY_MS);
  });

  it('leaves the existing callers on the post time', async () => {
    const queue = queueSpy();
    await enqueueHeldPost(queue, dbSpy(), post, NOW);
    expect(
      (queue as never as { add: jest.Mock }).add.mock.calls[0][2].delay,
    ).toBe(resumeDelayMs(post.scheduledAt, NOW));
  });

  /**
   * The job id carried only a millisecond timestamp, so two holds in the same
   * tick produced the same id — and BullMQ silently drops a duplicate, which
   * would strand the second post with no job.
   */
  it('gives two posts held in the same millisecond distinct job ids', async () => {
    const queue = queueSpy();
    await enqueueHeldPost(queue, dbSpy(), { id: 'a', scheduledAt: null }, NOW);
    await enqueueHeldPost(queue, dbSpy(), { id: 'b', scheduledAt: null }, NOW);
    const add = (queue as never as { add: jest.Mock }).add;
    expect(add.mock.calls[0][2].jobId).not.toBe(add.mock.calls[1][2].jobId);
  });
});
