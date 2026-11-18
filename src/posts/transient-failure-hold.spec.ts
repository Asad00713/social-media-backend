import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HELD_REASON,
  HELD_REASON_DISCONNECTED,
  HELD_REASON_RATE_LIMITED,
  HELD_REASON_TRANSIENT,
  holdTarget,
  holdTransient,
  isHeldByUserAction,
  isSelfReleasing,
  TRANSIENT_RETRY_DELAY_MS,
} from './lib/held-targets';
import type { PostTarget } from '../drizzle/schema/posts.schema';

/**
 * A retryable platform failure is held, not failed.
 *
 * `classifyPublishError` has computed `retryable` since it was written - true
 * for a 502/503/504, a timeout, `ECONNRESET`, "service unavailable" - and
 * **nothing read it**. Every caller took `.code` and discarded the flag:
 *
 *   src/platform-status/lib/classify.ts:134   classifyPublishError(message).code
 *   src/posts/lib/post-failure.ts:33          classifyPublishError(text).code
 *   src/posts/services/post.service.ts:1160   classifyPublishError(error).code
 *
 * So a target whose platform answered "503 Service Unavailable" was written
 * `status: 'failed'`. And because the per-target catch SWALLOWS the error, the
 * job completed successfully, so BullMQ never retried either - its three
 * attempts never came into play. The customer's post was permanently dead
 * because a platform was briefly unavailable, which is the one failure mode
 * retries exist for.
 *
 * The fix reuses the hold mechanism rather than inventing one: `transient` is
 * a fourth hold reason, released by time like `rate_limited`, and the 6h
 * `PUBLISH_LATE_GRACE_MS` still caps how long a post may keep waiting.
 */

const SRC = join(__dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const service = read('posts/services/post.service.ts');
const mapper = read('posts/composer/services/composer-error-mapper.service.ts');

function target(over: Partial<PostTarget> = {}): PostTarget {
  return {
    channelId: '7',
    platform: 'twitter',
    status: 'pending',
    ...over,
  } as PostTarget;
}

const NOW = new Date('2026-11-18T12:00:00.000Z');

describe('the classifier already knew, and was ignored', () => {
  it('still classifies a gateway failure as retryable', () => {
    // The flag this change finally reads. If the classifier stops setting it,
    // the hold below never happens and nothing else would notice.
    expect(mapper).toMatch(/return \{ code: 'transient', retryable: true \}/);
  });

  it('the publish path reads `retryable`, not only `.code`', () => {
    expect(service).toMatch(/classifyPublishError\(error\)/);
    expect(service).toMatch(/classified\.retryable/);
  });
});

describe('holdTransient', () => {
  it('holds the target without touching its status', () => {
    const held = holdTransient(target({ status: 'pending' }), NOW, '503');
    expect(held.heldReason).toBe(HELD_REASON_TRANSIENT);
    expect(held.heldAt).toBe(NOW.toISOString());
    // The post is still waiting, so the target is not `failed`.
    expect(held.status).toBe('pending');
  });

  it('keeps the message and code, so the author sees why it waits', () => {
    const held = holdTransient(target(), NOW, 'Service unavailable');
    expect(held.errorMessage).toBe('Service unavailable');
    expect(held.errorCode).toBe('transient');
  });

  /**
   * The downgrade that would publish to a channel someone deliberately
   * paused. A transient hold releases itself on a timer, so taking over a
   * user-caused hold would send the post anyway.
   */
  it.each([
    ['paused', HELD_REASON],
    ['disconnected', HELD_REASON_DISCONNECTED],
  ])('never downgrades a %s hold', (_label, reason) => {
    const already = holdTarget(target(), NOW, reason);
    const after = holdTransient(already, new Date(NOW.getTime() + 1000), 'x');
    expect(after.heldReason).toBe(reason);
    expect(after.heldAt).toBe(NOW.toISOString());
  });

  it('leaves an existing rate-limit hold alone', () => {
    const already = holdTarget(target(), NOW, HELD_REASON_RATE_LIMITED);
    const after = holdTransient(already, new Date(NOW.getTime() + 1000), 'x');
    expect(after.heldReason).toBe(HELD_REASON_RATE_LIMITED);
  });
});

describe('a transient hold is released by time, not by a person', () => {
  it.each([
    [HELD_REASON_RATE_LIMITED, true],
    [HELD_REASON_TRANSIENT, true],
    [HELD_REASON, false],
    [HELD_REASON_DISCONNECTED, false],
  ])('isSelfReleasing(%s) === %s', (reason, expected) => {
    expect(isSelfReleasing({ heldReason: reason } as PostTarget)).toBe(
      expected,
    );
  });

  /**
   * `isHeldByUserAction` gates everything that decides whether code MAY send
   * a held post. A transient hold must answer false, or the reconciler would
   * refuse to rebuild its retry and the post would wait forever.
   */
  it('is not a user-caused hold', () => {
    const held = holdTransient(target(), NOW, '503');
    expect(isHeldByUserAction(held)).toBe(false);
  });

  it('a paused hold still is', () => {
    expect(isHeldByUserAction(holdTarget(target(), NOW, HELD_REASON))).toBe(
      true,
    );
  });

  it('an unheld target is neither', () => {
    expect(isSelfReleasing(target())).toBe(false);
    expect(isHeldByUserAction(target())).toBe(false);
  });
});

describe('the retry delay', () => {
  it('is a fixed wait, since a platform outage announces no reopening time', () => {
    // A rate limit states when its window reopens; an outage does not, so the
    // delay is chosen rather than read.
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(5 * 60 * 1000);
  });

  it('is enqueued as a delayed job alongside the rate-limit one', () => {
    // Both self-releasing reasons share one job at the soonest of the two:
    // a target held by the later is simply held again on that run.
    expect(service).toMatch(/soonestRetry\(\s*rateLimitRetryMs/);
    expect(service).toMatch(/enqueueHeldPost\([\s\S]{0,200}delayMs:/);
  });
});

describe('what stays a failure', () => {
  /**
   * A partial publish is over: part of the post is already live on the
   * platform, so a blind retry would duplicate it. `itemResults` tells a
   * deliberate retry where to resume - that is the author's call.
   */
  it('a partial publish is not held', () => {
    expect(service).toMatch(/!\(error instanceof PartialPublishError\)/);
  });

  /**
   * Beyond the grace the post is stale, so holding it again would only delay
   * telling the author. Checked at the moment of the hold, not only on the
   * next run.
   */
  it('a post already past its grace is not held again', () => {
    expect(service).toMatch(
      /!isMissedRelease\(post\.scheduledAt, PUBLISH_LATE_GRACE_MS, now\)/,
    );
  });

  it('only `transient` is held; the other codes still fail', () => {
    // `rate_limited` is held earlier by the limiter, before the attempt.
    // `auth_failed`, `media_invalid`, `content_rejected`, `permanent` are all
    // retryable: false and must stay failures - retrying them forever would
    // hide a real problem from the author.
    expect(service).toMatch(/classified\.code === 'transient'/);
  });
});

describe('the post stays scheduled while it waits', () => {
  it('a transient hold counts towards anyHeld', () => {
    // Without this the post would read `failed` while holding a target and
    // carrying a delayed job - the status and the targets disagreeing, which
    // is the shape that keeps recurring here.
    expect(service).toMatch(/heldForTransient/);
    expect(service).toMatch(/anyHeld =\s*[\s\S]{0,120}heldForTransient/);
  });

  it('records the hold in post_history, as the other holds do', () => {
    const block = service.slice(service.indexOf('retryTransient'));
    expect(block.slice(0, 2000)).toMatch(/'held'/);
    expect(block.slice(0, 2000)).toMatch(/heldReason: HELD_REASON_TRANSIENT/);
  });
});
