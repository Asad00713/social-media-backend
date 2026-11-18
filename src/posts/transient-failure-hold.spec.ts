import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HELD_REASON,
  releaseTarget,
  HELD_REASON_DISCONNECTED,
  HELD_REASON_RATE_LIMITED,
  HELD_REASON_TRANSIENT,
  holdTarget,
  holdTransient,
  isHeldByUserAction,
  isSelfReleasing,
  TRANSIENT_RETRY_DELAY_MS,
} from './lib/held-targets';
import { reattemptTarget } from './lib/held-targets';
import { targetStatusOf } from './lib/post-status';
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
    status: 'scheduled',
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
    const held = holdTransient(target({ status: 'scheduled' }), NOW, '503');
    expect(held.heldReason).toBe(HELD_REASON_TRANSIENT);
    expect(held.heldAt).toBe(NOW.toISOString());
    // The post is still waiting, so the target is not `failed`.
    expect(held.status).toBe('scheduled');
    // And it reads as waiting, which is the property that actually matters:
    // `present-post` gates the hold markers on this being 'scheduled'.
    expect(targetStatusOf(held, 'scheduled')).toBe('scheduled');
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

  it('only a RETRYABLE code is held; the rest still fail', () => {
    // `auth_failed`, `media_invalid`, `content_rejected`, `permanent` are all
    // retryable: false and must stay failures - retrying them forever would
    // hide a real problem from the author. Asserted as the invariant (the
    // gate consults `retryable`) rather than as one code's spelling, which
    // is what this assertion used to pin - and it broke the moment the gate
    // correctly widened to cover a platform 429.
    expect(service).toMatch(/classified\.retryable &&/);
    expect(mapper).toMatch(/retryable: false/);
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
    // The reason that was actually taken, not a literal - the same block now
    // serves both self-releasing reasons.
    expect(block.slice(0, 2500)).toMatch(/heldReason: held\.heldReason/);
  });
});

/**
 * The case the first version of this spec missed entirely: it only ever
 * exercised a never-attempted target, so the retry-of-a-failed-target path
 * - the ORDINARY one, since an author retries a post precisely because it
 * failed - went untested, and a real divergence hid there.
 */
describe('retrying a target that failed before', () => {
  const failedEarlier = () =>
    target({
      status: 'failed',
      errorCode: 'permanent',
      errorMessage: 'bad creds',
    });

  it('clears the previous failure before the attempt', () => {
    const fresh = reattemptTarget(failedEarlier());
    expect(fresh.status).toBeUndefined();
    expect(fresh.errorCode).toBeUndefined();
    expect(fresh.errorMessage).toBeUndefined();
  });

  it('also clears a composer-written publishStatus', () => {
    // `targetStatusOf` reads either field, so clearing only `status` leaves
    // the same bug reachable by the composer's spelling.
    const fresh = reattemptTarget({
      ...failedEarlier(),
      publishStatus: 'failed',
    } as PostTarget);
    expect((fresh as { publishStatus?: string }).publishStatus).toBeUndefined();
  });

  /**
   * The divergence itself. Without the clear, a 503 on the retry stored a
   * target reading `failed` while the post read `scheduled` - and
   * `present-post` gates `heldAt`/`heldReason` on `status === 'scheduled'`,
   * so the hold vanished from the API and the UI could not say "retrying".
   */
  it('a transient hold on the retry still reads as waiting', () => {
    const held = holdTransient(reattemptTarget(failedEarlier()), NOW, '503');
    expect(held.heldReason).toBe(HELD_REASON_TRANSIENT);
    expect(targetStatusOf(held, 'scheduled')).toBe('scheduled');
  });

  it('carries the NEW error, not the old one', () => {
    const held = holdTransient(
      reattemptTarget(failedEarlier()),
      NOW,
      '503 Service Unavailable',
    );
    expect(held.errorMessage).toBe('503 Service Unavailable');
    expect(held.errorCode).toBe('transient');
  });

  it('a success on the retry is not shadowed by the old failure', () => {
    const fresh = reattemptTarget(failedEarlier());
    const published = { ...fresh, status: 'published' as const };
    expect(targetStatusOf(published, 'scheduled')).toBe('published');
  });

  /**
   * `reattemptTarget` must stay distinct from `releaseTarget`: resume and
   * reconnect release a hold WITHOUT attempting anything, and a target that
   * failed before must still read `failed` there.
   */
  it('releaseTarget still leaves a previous failure intact', () => {
    const released = releaseTarget(
      holdTarget(failedEarlier(), NOW, HELD_REASON),
    );
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('permanent');
  });

  it('the publish path uses reattemptTarget at the attempt', () => {
    expect(service).toMatch(/const target = reattemptTarget\(storedTarget\)/);
  });
});

/**
 * F3: the platform's OWN 429, which arrives in the catch rather than at the
 * pre-check (our limiter thought there was budget; the platform disagreed).
 * It is classified `rate_limited`, `retryable: true` - and the first version
 * of this change gated on `code === 'transient'`, so this one case kept the
 * exact bug the change set out to fix: permanently failed, no retry.
 */
describe('a platform-reported rate limit is held too', () => {
  it('the classifier marks it retryable', () => {
    expect(mapper).toMatch(
      /return \{ code: 'rate_limited', retryable: true \}/,
    );
    expect(mapper).toMatch(/RETRYABLE[\s\S]{0,80}'rate_limited'/);
  });

  it('the gate keys on `retryable`, not on a single code', () => {
    // The conjunct that excluded it. Keying on the flag is the whole point
    // of this branch: the classifier already knew, and was ignored.
    expect(service).not.toMatch(/classified\.code === 'transient' &&/);
    expect(service).toMatch(/classified\.retryable &&/);
  });

  it('holds it as a rate limit, with the limiter floor', () => {
    expect(service).toMatch(
      /const limited = classified\.code === 'rate_limited'/,
    );
    expect(service).toMatch(
      /holdRateLimited\(target, now\)[\s\S]{0,120}errorCode: 'rate_limited'/,
    );
    expect(service).toMatch(/RATE_LIMIT_MIN_DELAY_MS/);
  });

  it('records the reason it actually held, not a hard-coded one', () => {
    const block = service.slice(service.indexOf('const retryTransient'));
    expect(block.slice(0, 2500)).toMatch(/heldReason: held\.heldReason/);
  });

  it('a non-retryable code is still a failure', () => {
    // auth_failed / media_invalid / content_rejected / permanent.
    expect(mapper).toMatch(/retryable: false/);
  });
});
