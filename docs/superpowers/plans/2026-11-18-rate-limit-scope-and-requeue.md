# Rate-limit scope and re-queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop enforcing per-account platform limits as one app-wide budget, and hold a rate-limited post until its limit reopens instead of failing it.

**Architecture:** The per-channel limiter already has the right shape, so the "global" counter becomes a high runaway brake rather than a customer quota, and the per-channel numbers rise to what the platforms allow. A rate-limited target becomes a third hold reason in the existing `held-targets.ts` mechanism — held, not failed — enqueued with a delay of `retryAfterMs`.

**Tech Stack:** NestJS 11, BullMQ, ioredis, Drizzle, Jest.

**Spec:** `docs/superpowers/specs/2026-11-18-rate-limit-scope-and-requeue-design.md`

## Global Constraints

- Per-channel daily caps match the platforms: Instagram **50**, TikTok **25** per 24h (Buffer's published figures); Twitter stays **50/hour**. **Facebook is deliberately left absent** from the per-channel map: it has no entry today, and adding one would introduce a restriction where none existed — a separate decision from relaxing the three that already restrict.
- The app-wide brake is a runaway guard, not a quota: **2000 per platform per window**, and its refusal is logged at `error`, never surfaced to a customer as a rate-limit message.
- Grace for "may this still publish at all" is the existing `PUBLISH_LATE_GRACE_MS` (6h) in `scheduled-post-reconciler.service.ts`. Import it; do not redefine 6h.
- A rate-limited target is **held**, never `status: 'failed'`, unless its scheduled time is more than the grace in the past.
- New `PostService` constructor parameters go **last** — positional-argument specs break otherwise (54 failures last time).
- Never run repo-wide `prettier --write`; format only touched files.

## Review Focus

1. **`retryAfterMs` missing or zero** — `checkRateLimit` returns it only on the refusal path, and a malformed Redis reply makes it `now`. A hold with a zero delay must not spin: Task 3 asserts a floor.
2. **A target held for a rate limit while its channel is also paused** — two hold reasons on one target. `holdTarget` rewrites the reason, so the rate-limited hold must not erase `channel_paused` and let a paused channel publish. Task 3 asserts paused wins.
3. **Redis down during the limit check** — `checkRateLimit` throws rather than returning `allowed`. Today that propagates and burns BullMQ retries. Task 1 asserts an unreachable Redis is treated as allowed (fail-open), matching `getRateLimitStatus`'s existing degradation.
4. **A post whose scheduled time already passed the 6h grace when the limit hits** — must fail with the missed message, not hold forever. Task 3 covers it.
5. **An unknown/unlisted platform** — `perChannelLimits` has no entry for most platforms and returns `allowed: true, remaining: 999`. Raising the listed numbers must not accidentally start limiting the unlisted ones. Task 2 asserts the pass-through.

---

### Task 1: The app-wide counter becomes a runaway brake

**Files:**
- Modify: `src/queue/rate-limiter.service.ts:9-60` (the `PLATFORM_RATE_LIMITS` table and its header comment), `:155-195` (`checkRateLimit`)
- Test: `src/queue/rate-limiter.service.spec.ts`

**Interfaces:**
- Produces: `PLATFORM_RATE_LIMITS` keeps its shape (`Record<SupportedPlatform, {maxRequests, windowMs, description}>`) with `maxRequests: 2000` for every platform; `RUNAWAY_LIMIT_PER_WINDOW = 2000` exported for the tests to assert against.
- Produces: `checkRateLimit(platform)` resolves `{allowed: true, remaining: number, resetAt: Date}` when Redis is unreachable.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the app-wide limit is a runaway brake, not a customer quota', () => {
  it('is far above any per-account platform cap', () => {
    for (const [platform, limit] of Object.entries(PLATFORM_RATE_LIMITS)) {
      expect({ platform, max: limit.maxRequests }).toEqual({
        platform,
        max: RUNAWAY_LIMIT_PER_WINDOW,
      });
    }
  });

  it('treats an unreachable Redis as allowed rather than throwing', async () => {
    redis.zremrangebyscore = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(make('ready').checkRateLimit('instagram')).resolves.toMatchObject({
      allowed: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/queue/rate-limiter.service.spec.ts`
Expected: FAIL — `RUNAWAY_LIMIT_PER_WINDOW` is not exported; instagram is 20; the Redis rejection propagates.

- [ ] **Step 3: Implement**

Export `RUNAWAY_LIMIT_PER_WINDOW = 2000`; set every `maxRequests` in `PLATFORM_RATE_LIMITS` to it, keeping each `windowMs` and rewriting each `description` to say what it is (e.g. `'runaway brake: 2000 posts per 3 hours across the whole app'`). Replace the table's header comment: these are no longer "platform limits based on official API documentation" — that sentence is what caused the bug. Wrap the body of `checkRateLimit` so a Redis failure logs a warning and returns `{allowed: true, remaining: limit.maxRequests, resetAt: new Date(now + limit.windowMs)}`, matching how `getRateLimitStatus` already degrades.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/queue/rate-limiter.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queue/rate-limiter.service.ts src/queue/rate-limiter.service.spec.ts
git commit -m "fix(queue): the app-wide rate limit was enforcing a per-account cap"
```

---

### Task 2: Per-channel caps match the platforms

**Files:**
- Modify: `src/queue/rate-limiter.service.ts:225-232` (the `perChannelLimits` literal)
- Test: `src/queue/rate-limiter.service.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PER_CHANNEL_LIMITS` lifted to a module-level export (same shape as the current inline literal) so tests and future callers read one source.

- [ ] **Step 1: Write the failing tests**

```ts
describe('per-channel caps', () => {
  it.each([
    ['instagram', 50, 24 * 60 * 60 * 1000],
    ['tiktok', 25, 24 * 60 * 60 * 1000],
    ['twitter', 50, 60 * 60 * 1000],
  ])('allows %s %i per window', (platform, max, windowMs) => {
    expect(PER_CHANNEL_LIMITS[platform]).toEqual({ maxRequests: max, windowMs });
  });

  // Relaxing the three that already restrict is this task. Starting to
  // restrict a platform that does not is a different decision.
  it('adds no per-channel cap where there was none', () => {
    expect(Object.keys(PER_CHANNEL_LIMITS).sort()).toEqual([
      'instagram',
      'tiktok',
      'twitter',
    ]);
  });

  it('does not start limiting a platform that has no per-channel cap', async () => {
    const result = await make('ready').checkChannelRateLimit('mastodon', 'ch-1');
    expect(result.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/queue/rate-limiter.service.spec.ts`
Expected: FAIL — `PER_CHANNEL_LIMITS` is not exported; instagram is 10 and tiktok 5.

- [ ] **Step 3: Implement**

Move the inline `perChannelLimits` literal to a module-level `export const PER_CHANNEL_LIMITS`, raise instagram to 50 and tiktok to 25 (twitter unchanged), add no new platform keys, and have `checkChannelRateLimit` read from it. Each entry gets a comment naming its source (Buffer's published per-channel caps). Platforms absent from the map keep the existing `{allowed: true, remaining: 999}` pass-through.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/queue/rate-limiter.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queue/rate-limiter.service.ts src/queue/rate-limiter.service.spec.ts
git commit -m "fix(queue): per-channel caps were stricter than the platforms allow"
```

---

### Task 3: A rate-limited target is held, not failed

**Files:**
- Modify: `src/posts/lib/held-targets.ts` (add the reason; extend `enqueueHeldPost` with an explicit delay)
- Modify: `src/posts/services/post.service.ts:907-933` (global refusal) and `:942-970` (per-channel refusal)
- Test: `src/posts/lib/held-targets.spec.ts` (**exists** — add to it), `src/posts/rate-limit-hold.spec.ts` (create)

**Interfaces:**
- Consumes: `checkRateLimit` / `checkChannelRateLimit` from Tasks 1–2, each returning `{allowed, remaining, resetAt, retryAfterMs?}`.
- Produces: `HELD_REASON_RATE_LIMITED = 'rate_limited'`, added to the `HeldReason` union; `RATE_LIMIT_MIN_DELAY_MS = 60_000`; `enqueueHeldPost(queue, db, post, now, opts)` gains `opts.delayMs?: number`, which overrides `resumeDelayMs` when present.

⚠ `enqueueHeldPost` has **four existing call sites** — `channel-pause.service.ts:155,287,293` and `post.service.ts:1315`. `opts.delayMs` must be purely additive: every one of those calls omits it and must keep using `resumeDelayMs` exactly as today. Their suites are the check.

- [ ] **Step 1: Write the failing tests**

```ts
// held-targets.spec.ts
it('holds a rate-limited target without touching its status', () => {
  const held = holdTarget({ channelId: 'c1', status: 'pending' } as PostTarget, NOW, HELD_REASON_RATE_LIMITED);
  expect(held.heldReason).toBe('rate_limited');
  expect(held.status).toBe('pending');
});

it('a paused channel outranks a rate limit', () => {
  const paused = holdTarget({ channelId: 'c1' } as PostTarget, NOW, HELD_REASON);
  const after = holdRateLimited(paused, NOW);
  expect(after.heldReason).toBe(HELD_REASON);
});

it('never enqueues with a delay below the floor', async () => {
  const add = jest.fn(() => Promise.resolve({ id: 'j1' }));
  await enqueueHeldPost({ add }, dbStub, post, NOW, { delayMs: 0 });
  expect(add.mock.calls[0][2].delay).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_DELAY_MS);
});

// rate-limit-hold.spec.ts — source-level, same approach as posts.soft-delete.spec.ts
it('the rate-limit paths hold instead of failing', () => {
  const service = read('posts/services/post.service.ts');
  const block = service.slice(service.indexOf('globalRateLimit.allowed'));
  expect(block.slice(0, 900)).not.toMatch(/status: 'failed'/);
  expect(block.slice(0, 900)).toMatch(/HELD_REASON_RATE_LIMITED/);
});

it('fails a post already past the publish grace instead of holding it forever', () => {
  const service = read('posts/services/post.service.ts');
  expect(service).toMatch(/PUBLISH_LATE_GRACE_MS/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/posts/lib/held-targets.spec.ts src/posts/rate-limit-hold.spec.ts`
Expected: FAIL — `HELD_REASON_RATE_LIMITED`, `holdRateLimited`, `RATE_LIMIT_MIN_DELAY_MS` and `opts.delayMs` do not exist; both refusal blocks still set `status: 'failed'`.

- [ ] **Step 3: Implement**

In `held-targets.ts`: add `HELD_REASON_RATE_LIMITED` to the union; add `holdRateLimited(target, now)` that returns the target unchanged when `isHeld(target)` already holds a user-caused reason (so a paused or disconnected channel is never downgraded) and otherwise delegates to `holdTarget(target, now, HELD_REASON_RATE_LIMITED)`; add `RATE_LIMIT_MIN_DELAY_MS = 60_000`; give `enqueueHeldPost` an `opts.delayMs` that, when present, is used as `Math.max(opts.delayMs, RATE_LIMIT_MIN_DELAY_MS)` in place of `resumeDelayMs`.

In `post.service.ts`, both refusal blocks: replace the `status: 'failed'` push with `updatedTargets.push(holdRateLimited(target, now))`, keep the existing `recordHistory('rate_limited', …)` call unchanged, and set a flag so that after the loop the post is enqueued once via `enqueueHeldPost(..., { delayMs: retryAfterMs })` — unless `now - scheduledAt > PUBLISH_LATE_GRACE_MS`, in which case the target is failed with `MISSED_HELD_MESSAGE`. Import `PUBLISH_LATE_GRACE_MS` from the reconciler; do not redefine it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/posts/lib/held-targets.spec.ts src/posts/rate-limit-hold.spec.ts`
Expected: PASS

- [ ] **Step 5: Mutation-test the invariant**

Revert one refusal block to `status: 'failed'` and re-run; the rate-limit-hold spec must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/posts/lib/held-targets.ts src/posts/lib/held-targets.spec.ts src/posts/services/post.service.ts src/posts/rate-limit-hold.spec.ts
git commit -m "feat(posts): a rate-limited post waits for the limit instead of failing"
```

---

### Task 4: Verify the whole path and document it

**Files:**
- Create: `docs/publish-holds-and-rate-limits.md` — **no docs page covers holds today**; `grep -rln "HELD_REASON\|channel_paused" docs/` returns nothing but this plan and its spec.
- Test: the existing suites that touch these files

- [ ] **Step 1: Run every affected suite**

Run: `npx jest src/posts src/queue src/channels/services/channel-pause src/billing/services/post-queue`
Expected: PASS, with no new failures against the four known pre-existing ones (`pool-config`, `price-provisioning`, `billing.controller`, `evergreen.service`). The channel-pause suite is included because Task 3 touches `enqueueHeldPost`, which it depends on.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Write the holds doc**

Create `docs/publish-holds-and-rate-limits.md` covering: the three hold reasons and what releases each (`channel_paused` and `channel_disconnected` by a user action, `rate_limited` by time); why a hold is not a failure (a throw burns BullMQ retries and ends in `failed`); the 6h grace and that it is `PUBLISH_LATE_GRACE_MS`, shared with the reconciler; and that the app-wide counter is a runaway brake at 2000, not a customer quota — with one line on why it used to be 20 and what that cost.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(posts): rate_limited is the third hold reason"
```
