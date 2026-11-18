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
const reconciler = read('posts/services/scheduled-post-reconciler.service.ts');
const pauseService = read('channels/services/channel-pause.service.ts');
const presenter = read('posts/lib/present-post.ts');
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
    // Asserted via isMissedRelease rather than a hand-written comparison:
    // the grace moved ahead of the publish call, and the shared helper is
    // what the reconciler uses for the same question.
    expect(service).toMatch(/isMissedRelease\(/);
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

/**
 * Found by review, not by me, and all three were real.
 *
 * The first is the one that mattered: the grace check sat AFTER the publish
 * call, so it could only ever fire while the limit was still full — the moment
 * the window reopened the target simply published, however late. A post held
 * at 09:00 with a 20h retry would have gone out the next morning, twenty hours
 * late, marked `published`, with nothing said to anyone.
 */
describe('the grace is enforced before the publish, not after', () => {
  it('checks lateness before releaseTarget strips the hold', () => {
    const graceAt = service.indexOf('isMissedRelease(post.scheduledAt');
    const releaseAt = service.indexOf('const target = releaseTarget(storedTarget)');
    const publishAt = service.indexOf('this.publishToChannel(post, target)');
    expect(graceAt).toBeGreaterThan(-1);
    expect(graceAt).toBeLessThan(releaseAt);
    expect(graceAt).toBeLessThan(publishAt);
  });

  it('reads the stored target, whose hold markers still exist', () => {
    const block = service.slice(service.indexOf('isMissedRelease(post.scheduledAt') - 200);
    expect(block.slice(0, 260)).toMatch(/storedTarget\.heldReason === HELD_REASON_RATE_LIMITED/);
  });

  it('reuses the shared missed-release helper and message', () => {
    expect(service).toMatch(/isMissedRelease\(\s*post\.scheduledAt,\s*PUBLISH_LATE_GRACE_MS/);
    const block = service.slice(service.indexOf('isMissedRelease(post.scheduledAt'));
    expect(block.slice(0, 500)).toMatch(/MISSED_HELD_MESSAGE/);
  });
});

/**
 * A rate-limit hold has no user action behind it, so anything that decides
 * "leave held posts alone" has to distinguish it from a paused one — or the
 * post is stranded with no way out.
 */
describe('a rate-limit hold is not a user-caused hold', () => {
  it('the library draws the distinction in one place', () => {
    expect(held).toMatch(/export function isHeldByUserAction/);
  });

  /**
   * The reconciler skips held posts so it cannot publish to a paused channel.
   * Applying that to a rate-limit hold made it refuse to rebuild the one thing
   * that releases it: lose the job (a Redis flush) and the post sits
   * `scheduled` forever, never publishing and never failing.
   */
  it('the reconciler can still re-arm a rate-limited post', () => {
    expect(reconciler).toMatch(/some\(isHeldByUserAction\)/);
    expect(reconciler).not.toMatch(/some\(isHeld\)/);
  });

  /**
   * The mirror image of holdRateLimited's guard. Relabelling a rate-limit
   * hold as `channel_paused` stops it releasing itself, and its retry job then
   * fires into a paused target and re-holds it — the post never publishes.
   */
  it('a channel reconnect leaves a rate-limit hold alone', () => {
    expect(pauseService).toMatch(/heldReason !== HELD_REASON_RATE_LIMITED/);
  });
});

describe('what the customer is told', () => {
  /**
   * The presenter collapsed every reason but `channel_disconnected` to
   * `channel_paused`, so a rate-limited post told the user to resume a channel
   * they had never paused — and there was no resume to press.
   */
  it('reports rate_limited rather than calling it a pause', () => {
    expect(presenter).toMatch(/target\.heldReason === 'rate_limited'/);
  });

  it('the planner DTO carries the third reason', () => {
    expect(read('posts/dto/planner-post.dto.ts')).toMatch(
      /'channel_paused' \| 'channel_disconnected' \| 'rate_limited'/,
    );
  });

  /**
   * `allSuccess` is false for a hold as well as a failure, so this wrote
   * "Some channels failed to publish" onto a post that was merely waiting —
   * and present-post reuses lastError as fallback text for a failed target.
   */
  it('a post that is only waiting carries no error', () => {
    expect(service).toMatch(/const nothingFailed = updatedTargets\.every/);
    expect(service).toMatch(/allSuccess \|\| nothingFailed \? null/);
  });
});
