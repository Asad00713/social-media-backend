# Publish holds and rate limits

When a scheduled post cannot be sent, there are two things to do with it: fail
it, or hold it. This describes which, and why.

## A hold is not a failure

A failure says _this post will not go out, and you need to do something_. A
hold says _this post still intends to go out, and nothing is wrong with it_.

A target on a paused channel is the clearest case: the user paused that
channel, so not publishing is the correct behaviour, and marking the post
`failed` would blame the customer for their own setting. `src/posts/lib/held-targets.ts`
holds it instead — `heldAt` and `heldReason` are set, **the status fields are
left exactly as they were**, and the post stays `scheduled`.

The same file's header states the other half of the reason: a publish job that
throws burns a BullMQ retry and ends in `failed` anyway, so refusing loudly is
not an option either.

## The three hold reasons

| Reason                 | Set when                                           | Released by                                     |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `channel_paused`       | The user paused the channel                        | The user resuming it                            |
| `channel_disconnected` | The channel was soft-disconnected (migration 0081) | The user reconnecting it                        |
| `rate_limited`         | The platform's per-account limit is full           | **Time** — a job waits for the window to reopen |

`rate_limited` is the odd one out, and every difference follows from that one
fact. The first two wait for a person; this one knows exactly when it can go,
because the limiter computed it.

### Why a rate limit never overwrites another hold

`holdTarget` rewrites the reason, so calling it for a rate limit on an
already-held target would turn `channel_paused` into `rate_limited`. The post
would then release itself on a timer and publish to a channel the user had
deliberately paused.

`holdRateLimited` therefore returns an already-held target untouched. The rate
limit will still be there when the user resumes; it simply declines to take
ownership of a hold it did not create.

### The retry delay

`enqueueHeldPost(..., { delayMs })` is the rate-limit path. Every other caller
omits `delayMs` and goes at the post's own time, as before.

Two guards on that delay:

- **A one-minute floor** (`RATE_LIMIT_MIN_DELAY_MS`). `retryAfterMs` can
  legitimately be `0` when a window reopens between the check and the hold, and
  retrying at once would hit the same limit and hold again, in a tight loop.
- **Clamped at the source.** `retryAfterMs` used to be able to come back `NaN`
  from a malformed Redis reply. It is now a job delay, where `NaN` would be an
  invalid delay rather than a late retry, so `rate-limiter.service.ts` clamps it
  before returning.

With several targets rate-limited at once by different windows, the job goes at
the **soonest** (`soonestRetry`). A target whose window is further out is simply
held again on that run, which is correct; going at the latest would hold the
earlier ones for no reason.

## The six-hour grace

A post may wait for a rate limit, but not indefinitely — publishing something
six hours stale surprises its author more than skipping it. Past
`PUBLISH_LATE_GRACE_MS` the held targets are failed with `MISSED_HELD_MESSAGE`,
the same message a held post gets when its channel comes back too late, because
it is the same situation: its time came and went while it could not be sent.

**The check runs before the publish attempt, at the top of the loop, reading
`storedTarget` while its hold markers still exist.** This is load-bearing and
was wrong in the first draft of this work. Once a limit window reopens, both
limit checks return `allowed` and the target publishes — so a grace check
placed after the publish can only ever catch a target that was _re-held_ on the
same run, which is to say only while the limit is still full. That is precisely
the case where lateness does not matter yet. A post held at 09:00 with a
twenty-hour retry would have published the next morning, twenty hours late,
marked `published`, with nothing said to anyone.

The reconciler gets this right the same way, by checking before re-arming.

That constant lives in `held-targets.ts`, not in either service. The publish
path and `ScheduledPostReconciler` are answering the same question — _may this
post still go out?_ — and two copies of six hours drift. A change to one that
missed the other would let a post the reconciler calls stale be published
anyway.

## The app-wide counter is a runaway brake, not a quota

`PLATFORM_RATE_LIMITS` in `src/queue/rate-limiter.service.ts` looks like a table
of platform limits and used to be described as one. That was the bug.

Those numbers are **per connected account** — the table's own comments said so
("Instagram is very strict: 25 per 24 hours") — and they were counted in a
single Redis key, `ratelimit:global:<platform>`, shared by every customer. So
Instagram's per-account allowance was enforced as 20 posts per day across the
whole application. Fifty customers shared one customer's budget, and each was
refused for traffic none of them sent.

No scheduling tool works this way, because no platform imposes an app-wide
posting cap. Buffer publishes per-channel daily caps; Publer's documentation
says its limits are "applied per user account".

What the counter is now: a brake on a runaway loop. A bug that publishes
repeatedly could get the whole application's API access revoked, which _is_ an
app-wide risk and would hit every customer. `RUNAWAY_LIMIT_PER_WINDOW` (2000)
stops that without standing in anyone's way, and hitting it is logged at
`error` with wording that cannot be mistaken for a customer quota — if it ever
fires, something is wrong with us, not with a customer.

The real limit is `PER_CHANNEL_LIMITS`, keyed by channel, with the numbers the
platforms actually allow. A platform absent from that map is not rate-limited
here; only the three that already restricted are listed, because adding a
fourth would newly cap customers who are not capped today.

## A rate-limit hold is not a user-caused hold

Anywhere code decides whether it may send or release a held post, the reason
has to be consulted — `isHeldByUserAction` draws the line in one place.

A paused or disconnected hold has a person behind it, so leaving it alone is
safe: resuming or reconnecting is what sends the post. A rate-limit hold has
nobody behind it. Only time releases it, and only a job carries that time, so
"leave it alone" is how it gets stranded. Three places had to learn the
difference:

| Place                                                                     | Without the distinction                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScheduledPostReconciler` skips held posts                                | Lose the retry job (a Redis flush) and the post sits `scheduled` and held forever — never publishing, never failing. The one component that rebuilds lost jobs was refusing to.                         |
| `ChannelPauseService.releaseAfterReconnect` relabels this channel's holds | A `rate_limited` hold became `channel_paused`, so it stopped releasing itself and waited for a resume the user had no reason to expect — while its retry job fired into a paused target and re-held it. |
| `holdRateLimited` itself                                                  | The same downgrade from the other direction: a paused channel relabelled `rate_limited` would publish on a timer to a channel someone deliberately paused.                                              |

## What the customer sees

The Planner shows the hold with its own reason. This matters because the copy
differs in kind: a paused channel says _resume it to publish now_, and for a
rate limit there is nothing to press — it retries itself. Collapsing the
reasons told people to resume a channel they had never paused.

`present-post.ts` passes `rate_limited` through, and `PlannerPostDto` carries
it, so the frontend type knows all three values.

## Degradation

Both limit checks treat an unreachable Redis as **allowed**. Refusing would
turn a brief Redis problem into failed posts for every customer, and the thing
being guarded against — a runaway loop — is far rarer than a connection blip.
`getRateLimitStatus` already degraded this way; the checks match it rather than
inventing a second policy.

A failure to enqueue the retry job is logged, not thrown. By that point the
post's other targets have already published, and throwing would burn a BullMQ
retry and publish them a second time. The post is left `scheduled` and held —
exactly the shape `ScheduledPostReconciler` repairs, within 15 minutes.

## Where to look

|                                             |                                                           |
| ------------------------------------------- | --------------------------------------------------------- |
| Hold primitives, the grace, the delay floor | `src/posts/lib/held-targets.ts`                           |
| The two limit checks and both tables        | `src/queue/rate-limiter.service.ts`                       |
| Where holds are decided during a publish    | `src/posts/services/post.service.ts` (`publishPost`)      |
| Recovery when a job is lost                 | `src/posts/services/scheduled-post-reconciler.service.ts` |
| What must not regress                       | `src/posts/rate-limit-hold.spec.ts`                       |

## A fourth hold reason: `transient_error`

Phase 3 item #1. The audit asked to "use `retryable` + add 5xx detection".
Checking the code first: **5xx detection already existed** —
`classifyPublishError` has matched `50[234]`, `ETIMEDOUT`, `ECONNRESET`,
`EAI_AGAIN`, "service unavailable", "bad gateway" and more since it was
written, returning `{ code: 'transient', retryable: true }`.

What was missing is that **nothing read `retryable`**. All three callers took
`.code` and discarded the flag:

```
src/platform-status/lib/classify.ts:134   classifyPublishError(message).code
src/posts/lib/post-failure.ts:33          classifyPublishError(text).code
src/posts/services/post.service.ts:1160   classifyPublishError(error).code
```

So a target whose platform answered `503 Service Unavailable` was written
`status: 'failed'`. And because the per-target `catch` **swallows** the error,
the job completed successfully — so BullMQ's three attempts never came into
play either. A customer's post was permanently dead because a platform was
briefly unavailable, which is the one failure mode retries exist for.

### The fix reuses the hold mechanism

`transient` becomes a fourth hold reason rather than a parallel code path,
exactly as `rate_limited` did:

```ts
export const HELD_REASON_TRANSIENT = 'transient_error' as const;
```

`holdTransient` mirrors `holdRateLimited`, including its refusal to take over
an existing hold — a paused channel downgraded to a self-releasing reason
would publish to a channel someone deliberately paused. It keeps
`errorMessage`/`errorCode` (the attempt really did fail, and "Service
unavailable, retrying" beats a silent wait) while leaving `status` untouched,
so the post stays `scheduled`.

### `isSelfReleasing`, instead of a comparison per site

The release paths were written `heldReason !== HELD_REASON_RATE_LIMITED` when
that was the only timer-released reason, and **every one of them had to be
found again** when a second appeared — the channel-pause release, the grace
check, `isHeldByUserAction`. They now ask one exported predicate, so a third
reason needs no new site:

```ts
export function isSelfReleasing(
  target: Pick<PostTarget, 'heldReason'>,
): boolean;
```

### What is deliberately NOT held

| Case                                                            | Why it stays a failure                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a partial publish                                               | part of the post is already live, so a blind retry duplicates it; `itemResults` lets a deliberate retry resume |
| already past the 6h grace                                       | the post is stale; holding again would only delay telling the author                                           |
| `auth_failed`, `media_invalid`, `content_rejected`, `permanent` | all `retryable: false` — retrying forever would hide a real problem                                            |

The gate is **`classified.retryable`**, not one code. An earlier version of
this change read `code === 'transient'`, which silently excluded
`rate_limited` — also `retryable: true`. That mattered because a platform's
OWN 429 is raised from the publish call, not from our pre-check: our limiter
thought there was budget and the platform disagreed. So that one case kept the
exact defect this document describes — permanently failed, catch swallows it,
no BullMQ retry — while looking fixed. A platform 429 now holds as
`rate_limited` at the limiter's 60s floor (no `retry-after` is parsed from a
thrown error), and only `retryable: false` codes stay failures.

### A retry clears the previous attempt's failure

`releaseTarget` strips the hold markers and nothing else, which is right for
resume and reconnect — they release a hold **without** attempting anything, and
a target that failed before must still read `failed` there. It is not enough at
the attempt itself: a target that failed earlier keeps `status: 'failed'` and
its old `errorCode`/`errorMessage` through the release, so a retry that was
then held stored a target reading `failed` under a post reading `scheduled`.

Three things went wrong with that, all at once:

- `targetStatusOf` answers `'failed'`, so the row and its only target disagree;
- `present-post` gates `heldAt`/`heldReason` on `status === 'scheduled'`, so
  the hold **vanished from the API** and the UI could not say "retrying";
- `nothingFailed` was false, so `lastError` was written on a post that is in
  fact waiting — the one thing the hold logic is written to avoid.

`reattemptTarget` is used at the attempt instead. It clears both status fields
(`targetStatusOf` reads either, so clearing only `status` leaves a
composer-written `publishStatus: 'failed'` winning) and the stale error — which
is also what `PostTarget.errorCode` has always documented: _"cleared when the
target is attempted again"_, a promise the code did not keep.

### The delay is chosen, not read

A rate limit states when its window reopens; an outage announces nothing. So
`TRANSIENT_RETRY_DELAY_MS` is a flat 5 minutes — long enough for a blip to
pass, short enough that a post scheduled to the minute is not noticeably late.
Both self-releasing reasons share **one** delayed job, at `soonestRetry` of the
two: a target held by the later one is simply held again on that run, which is
correct, while waiting for the later would hold the earlier needlessly.

`PUBLISH_LATE_GRACE_MS` (6h) still caps the total, so a platform that is down
for a day fails the post and tells the author rather than retrying silently
forever.

### Tests

`transient-failure-hold.spec.ts` (21 tests). Mutation-tested:

| Mutation                                          | Tests that fail |
| ------------------------------------------------- | --------------- |
| ignore `retryable` (the original bug)             | 1               |
| treat `transient` as a user-caused hold           | 2               |
| drop the "never downgrade an existing hold" guard | 3               |

The third matters most: without it a transient failure on a paused channel
would take over that hold and publish on a timer to a channel the user
deliberately paused.

Five assertions in `rate-limit-hold.spec.ts` also had to change — they pinned
the old _spellings_ (`heldReason !== HELD_REASON_RATE_LIMITED`,
`delayMs: rateLimitRetryMs`, the DTO union on one line) rather than the
invariants, so they failed while the properties they describe still held. They
now assert the behaviour: a delay is passed and guarded, the grace is judged on
the stored hold, each self-releasing reason is named in the presenter.
