import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the decisions behind rate-limit holds.
 *
 * `publishPost` reaches publishers, calendar sync, notifications and campaign
 * sync, so standing it up to assert these would mock most of the application.
 * The behaviour itself is covered by post.service.failure-event.spec.ts, which
 * drives a real publish and asserts the target comes back held.
 *
 * What this file protects is narrower and easy to undo by accident: that no
 * rate-limit path reverts to `status: 'failed'`, that the grace is the shared
 * constant rather than a second copy of six hours, and that a held post is
 * given a job rather than left for the reconciler. Those are properties of the
 * source, so the source is what is read — the same approach as
 * posts.soft-delete.spec.ts.
 */

const SRC = join(__dirname, '..');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

const service = read('posts/services/post.service.ts');
const limiter = read('queue/rate-limiter.service.ts');
const held = read('posts/lib/held-targets.ts');

/** The source of a refusal branch, from its guard to its `continue`. */
function refusalBlock(marker: string): string {
  const start = service.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = service.indexOf('continue;', start);
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
}

describe('a rate-limited target is held, not failed', () => {
  it.each([
    ['the app-wide brake', 'if (!globalRateLimit.allowed)'],
    ['the per-channel limit', 'if (!channelRateLimit.allowed)'],
  ])('%s holds the target', (_label, marker) => {
    const block = refusalBlock(marker);
    expect(block).toMatch(/holdRateLimited\(target, now\)/);
  });

  /**
   * The regression this exists for. Marking the target failed is what the
   * code did before, and it is a one-line change away at all times.
   */
  it.each([
    ['the app-wide brake', 'if (!globalRateLimit.allowed)'],
    ['the per-channel limit', 'if (!channelRateLimit.allowed)'],
  ])('%s never sets status failed', (_label, marker) => {
    expect(refusalBlock(marker)).not.toMatch(/status: 'failed'/);
  });

  it('records the hold in post_history rather than a failure', () => {
    for (const marker of [
      'if (!globalRateLimit.allowed)',
      'if (!channelRateLimit.allowed)',
    ]) {
      const block = refusalBlock(marker);
      expect({ marker, held: /'held'/.test(block) }).toEqual({
        marker,
        held: true,
      });
    }
  });
});

describe('the hold releases itself', () => {
  it('enqueues a job at the retry time, so the reconciler stays out of it', () => {
    expect(service).toMatch(/enqueueHeldPost\([\s\S]{0,160}delayMs: rateLimitRetryMs/);
  });

  /**
   * A queue failure here must not throw: the other targets already published,
   * and throwing would burn a BullMQ retry and publish them twice. The post is
   * left in exactly the shape the reconciler repairs.
   */
  it('does not throw when the queue is unavailable', () => {
    const tail = service.slice(service.indexOf('delayMs: rateLimitRetryMs'));
    expect(tail.slice(0, 700)).toMatch(/catch/);
  });

  it('floors the delay so a zero retry cannot spin', () => {
    expect(held).toMatch(/RATE_LIMIT_MIN_DELAY_MS/);
    expect(held).toMatch(/Math\.max\(opts\.delayMs, RATE_LIMIT_MIN_DELAY_MS\)/);
  });
});

describe('the six-hour grace has one definition', () => {
  it('lives in the hold library', () => {
    expect(held).toMatch(/export const PUBLISH_LATE_GRACE_MS = 6 \* 60 \* 60 \* 1000/);
  });

  /**
   * Two copies of six hours drift. The reconciler and the publish path are
   * answering the same question — may this post still go out — so a change to
   * one that misses the other would let a post the reconciler calls stale be
   * published anyway.
   */
  it.each([
    ['the publish path', 'posts/services/post.service.ts'],
    ['the reconciler', 'posts/services/scheduled-post-reconciler.service.ts'],
  ])('%s imports it rather than redefining it', (_label, file) => {
    const body = read(file);
    expect(body).toMatch(/PUBLISH_LATE_GRACE_MS/);
    expect(body).not.toMatch(/PUBLISH_LATE_GRACE_MS\s*=\s*\d/);
  });

  it('fails a post that is past the grace instead of holding it forever', () => {
    expect(service).toMatch(/lateBy > PUBLISH_LATE_GRACE_MS/);
    expect(service).toMatch(/MISSED_HELD_MESSAGE/);
  });
});

describe('the app-wide limit is not a customer quota', () => {
  /**
   * The original defect: per-account platform numbers counted in one Redis key
   * shared by every customer. A number like 20 or 25 reappearing in
   * PLATFORM_RATE_LIMITS is that bug coming back.
   */
  it('every app-wide entry is the runaway brake', () => {
    const table = limiter.slice(
      limiter.indexOf('export const PLATFORM_RATE_LIMITS'),
      limiter.indexOf('export const PER_CHANNEL_LIMITS'),
    );
    expect(table).not.toMatch(/maxRequests: \d+/);
    expect(table).toMatch(/maxRequests: RUNAWAY_LIMIT_PER_WINDOW/);
  });

  it('keeps the per-account denominator keyed by channel', () => {
    expect(limiter).toMatch(/ratelimit:channel:\$\{platform\}:\$\{channelId\}/);
  });
});
