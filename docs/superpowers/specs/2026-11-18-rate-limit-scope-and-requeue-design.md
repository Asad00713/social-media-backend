# Rate-limit scope and re-queue — design

Phase 2 items #1 and #2 of the production-readiness audit. Both concern what
happens when a platform rate limit is reached, and they share one code path, so
they ship together.

## The two defects

### 1. The "global" limit is a fiction

`rate-limiter.service.ts` holds a table called `PLATFORM_RATE_LIMITS` whose
comments name their own source:

```ts
instagram: { maxRequests: 20, ... }  // "Instagram is very strict: 25 per 24 hours"
twitter:   { maxRequests: 200, ... } // "Twitter allows 300 tweets per 3 hours"
```

Those platform numbers are **per connected account**. The code counts them in
one Redis key shared by every customer:

```
ratelimit:global:instagram
```

So Instagram's "25 posts per account per day" is enforced as "20 posts per day
across all of Schedura". With 50 customers, they share one customer's budget.
This is not a fairness bug — it is a wrong denominator, and it penalises every
customer at once rather than one noisy neighbour.

Verified against the competition: Buffer publishes per-channel daily caps
(Instagram 50, TikTok 25, Facebook 35 per 24h). Publer's own documentation says
its limits are "applied per user account (across all API keys)" and "Per
profile/account". **Neither tool has an app-wide posting cap**, because no
platform imposes one.

The audit framed this as "add a workspace dimension to the keys". That would
still be a wrong denominator: the limit belongs to a *channel*, and one
workspace can connect five Instagram accounts.

`checkChannelRateLimit` already keys per channel
(`ratelimit:channel:${platform}:${channelId}`) — the correct shape exists. Its
numbers are just lower than the platforms allow (Instagram 10/day vs Buffer's
50), so a customer is currently throttled twice: once wrongly, once early.

### 2. A rate-limited post is marked `failed`

`post.service.ts:907-933` and `:942-970` compute `retryAfterMs`, write it into
the error message and into `post_history` — and then set the target
`status: 'failed'`. The exact time the limit reopens is known and discarded.

The customer sees a dead post and has to resend it by hand.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Keep an app-wide cap? | Yes, but as a **runaway brake**, not a customer limit — a high ceiling, not a per-account number | A looping bug could get the whole app banned from a platform, which hits every customer. That risk is real; it is just not the customer's quota. |
| Per-channel numbers | Raise to what the platforms actually allow | Being stricter than the platform throttles paying customers for nothing |
| Rate-limited post | **Re-queue for when the limit reopens**; mark `failed` only if that is more than **6 hours** out | Owner's decision. `retryAfterMs` gives the exact reopening time, so most posts publish by themselves. Beyond 6h the post is too stale to publish unannounced. |
| Grace constant | Reuse `PUBLISH_LATE_GRACE_MS` (6h) from the reconciler | Same question — "how late may a post still publish" — so one answer, in one place |

## Re-queue reuses the hold mechanism, it does not invent one

`src/posts/lib/held-targets.ts` already solves this exact problem for a
different cause. Its own header states the rule:

> A publish job that fires for a paused channel must neither fail the target
> nor throw (a throw burns BullMQ retries and ends in "failed"). The target is
> HELD instead: its status is left as it was, `heldAt`/`heldReason` record why
> it did not go, and the post stays `scheduled`.

A rate-limited target wants precisely that behaviour, so it becomes a third
hold reason rather than a parallel code path:

```ts
export const HELD_REASON_RATE_LIMITED = 'rate_limited' as const;
```

What already exists and is reused unchanged: `holdTarget` (sets
`heldAt`/`heldReason`, leaves status alone), `releaseTarget`, `isHeld`,
`enqueueHeldPost` (enqueues `heldOnly` and repoints `posts.job_id`),
`isJobPending`, and the `missedHeld` path that fails a target whose time has
passed with `MISSED_HELD_MESSAGE`.

What differs from a paused channel, and is the only new behaviour: a paused
channel is released by a user action, while a rate limit releases itself at a
known time. So the rate-limited hold is enqueued with an explicit delay of
`retryAfterMs` instead of waiting for a resume.

### Consequences the implementation must respect

1. **`isHeld` is already load-bearing elsewhere.** `ScheduledPostReconciler`
   skips held posts on purpose — a held post is `scheduled` with no job *by
   design*. A rate-limited hold **does** carry a delayed job, so it must not
   be left for the reconciler to re-arm; `enqueueHeldPost` sets `job_id`,
   which keeps `isJobPending` true and the reconciler away.
2. **`scheduledAt` stays untouched.** The hold mechanism deliberately does not
   move it (that is how the resume path knows the post's real time via
   `resumeDelayMs`). Lateness is therefore still measured against the time the
   customer chose, which is correct: the 6h grace asks "may this still publish
   at all", and a rate limit does not change the answer.
3. The stranded-post sweeper is unaffected: it looks for rows stuck in
   `publishing`, and a held post is `scheduled`.

## What the customer sees

A re-queued post stays in the planner at its new time, with the reason
recorded in `post_history` (`rate_limited`, already written today). The
existing `PublishFailureNotifier` keeps its current behaviour for the posts
that do exhaust the grace — this change does not add a notification, it
removes most of the failures that would have triggered one.

## Out of scope

- Queue fairness/priority (audit Phase 2 #1's second half) — a separate change
  to BullMQ job options, with no overlap with these files
- Per-plan queue caps — `plans.queued_posts_per_channel` already exists
- Audit #3 (`postFailed` wiring) — already shipped with the email work
