# Publish holds and rate limits

When a scheduled post cannot be sent, there are two things to do with it: fail
it, or hold it. This describes which, and why.

## A hold is not a failure

A failure says *this post will not go out, and you need to do something*. A
hold says *this post still intends to go out, and nothing is wrong with it*.

A target on a paused channel is the clearest case: the user paused that
channel, so not publishing is the correct behaviour, and marking the post
`failed` would blame the customer for their own setting. `src/posts/lib/held-targets.ts`
holds it instead — `heldAt` and `heldReason` are set, **the status fields are
left exactly as they were**, and the post stays `scheduled`.

The same file's header states the other half of the reason: a publish job that
throws burns a BullMQ retry and ends in `failed` anyway, so refusing loudly is
not an option either.

## The three hold reasons

| Reason | Set when | Released by |
|---|---|---|
| `channel_paused` | The user paused the channel | The user resuming it |
| `channel_disconnected` | The channel was soft-disconnected (migration 0081) | The user reconnecting it |
| `rate_limited` | The platform's per-account limit is full | **Time** — a job waits for the window to reopen |

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

That constant lives in `held-targets.ts`, not in either service. The publish
path and `ScheduledPostReconciler` are answering the same question — *may this
post still go out?* — and two copies of six hours drift. A change to one that
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
repeatedly could get the whole application's API access revoked, which *is* an
app-wide risk and would hit every customer. `RUNAWAY_LIMIT_PER_WINDOW` (2000)
stops that without standing in anyone's way, and hitting it is logged at
`error` with wording that cannot be mistaken for a customer quota — if it ever
fires, something is wrong with us, not with a customer.

The real limit is `PER_CHANNEL_LIMITS`, keyed by channel, with the numbers the
platforms actually allow. A platform absent from that map is not rate-limited
here; only the three that already restricted are listed, because adding a
fourth would newly cap customers who are not capped today.

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

| | |
|---|---|
| Hold primitives, the grace, the delay floor | `src/posts/lib/held-targets.ts` |
| The two limit checks and both tables | `src/queue/rate-limiter.service.ts` |
| Where holds are decided during a publish | `src/posts/services/post.service.ts` (`publishPost`) |
| Recovery when a job is lost | `src/posts/services/scheduled-post-reconciler.service.ts` |
| What must not regress | `src/posts/rate-limit-hold.spec.ts` |
