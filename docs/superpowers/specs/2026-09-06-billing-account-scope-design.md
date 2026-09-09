# Billing: Account Scope + Pricing Model — Design

**Date:** 2026-09-06
**Branch:** `feat/billing-account-scope`
**Status:** Approved, ready for planning

## Problem

Billing is workspace-scoped, but the plans it sells are account-scoped. The two
contradict each other, and the contradiction is visible in the code.

`usage.service.ts:91-121` resolves a user's workspace limit like this:

```ts
let maxWorkspaces = 1;
for (const ws of userWorkspaces) {          // every workspace the user owns
  const subscription = ...                   // its own subscription
  if (plan.maxWorkspaces > maxWorkspaces)
    maxWorkspaces = plan.maxWorkspaces;      // keep the largest
}
```

That loop means *"find the most expensive plan across all of this user's
workspaces and treat it as the user's plan."* It is a workaround for a model
that does not fit, and it is exploitable: buy MAX on one workspace, FREE on
another, and the MAX `maxWorkspaces` applies to both.

The deeper problem is what a customer is sold. `plans.maxWorkspaces` promises
"3 workspaces" on Pro — but because each workspace needs its own subscription,
using that promise means paying three times. The plan's promise and the billing
model contradict each other.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Subscription scope | **user** (`userId`), not workspace | One payer, one subscription; makes `maxWorkspaces` mean what it says |
| Billing entity | `users` directly, no new `accounts` table | `stripe_customers` is already user-scoped; a new entity is not needed yet |
| Channel limits | stay **per-workspace** | User's explicit choice; matches the agency shape (client A, client B) |
| Workspaces | in the plan tier **and** buyable as `EXTRA_WORKSPACE` | A user on a 1-workspace tier who needs a 4th shouldn't have to upgrade the whole tier |
| `EXTRA_WORKSPACE` grants | **0 channels** — empty workspace | Prevents arbitrage (see below) |
| Post limits | **queued** per channel, not monthly quota | Matches Buffer/Publer; no counter table, no reset cron, no user-facing counting |
| Members | stay limited, `EXTRA_MEMBER` add-on kept | User's explicit choice |
| Existing data | truncate and reseed | Only 2 subscriptions exist, both Stripe **test mode** on the team's own accounts — no real money ever moved |

### Why `EXTRA_WORKSPACE` must grant zero channels

Channel limits are per-workspace. If a purchased workspace arrived carrying the
tier's `channelsPerWorkspace`, buying a workspace would be a cheaper way to buy
channels whenever `price(EXTRA_WORKSPACE) < channelsPerWorkspace ×
price(EXTRA_CHANNEL)`. People find that arbitrage. An empty workspace closes it:
workspaces and channels are priced and bought independently.

### Why queued limits instead of a monthly quota

Researched 2026 competitor pricing: no major tool sells a monthly post quota.
Buffer's free tier caps *queued* posts per channel and frees the slot on publish;
paid tiers are unlimited. Publer is the same shape.

A monthly quota would also cost us more to build and run: a usage counter, a
monthly reset cron, and drift between the counter and reality. A queued limit is
a live `COUNT` over posts already in `scheduled` status — self-correcting, no new
table, and nothing to reset.

## Architecture

```
users
  └── subscriptions            (userId UNIQUE — one user, one subscription)
        └── subscription_items (BASE_PLAN, EXTRA_WORKSPACE, EXTRA_CHANNEL, EXTRA_MEMBER)

workspace (ownerId → users)
  └── workspace_usage          (materialized per-workspace limits — unchanged shape)
```

`workspace_usage` already materializes `channelsLimit`, `membersLimit`, and
`extraChannelsPurchased` per workspace. That table does not change. Only the
*source* of those numbers changes: the owner's single subscription rather than
the workspace's own.

### Schema changes

**`subscriptions`**
- `workspace_id` (uuid, UNIQUE) → `user_id` (uuid, UNIQUE, FK `users.id` cascade)
- `stripe_customer_id` → **nullable** (a later effort adds a second provider;
  making it nullable now avoids a second migration then)

**`plans`**
- add `queued_posts_per_channel` (integer, NOT NULL) — `-1` means unlimited
- `channels_per_workspace`, `members_per_workspace`, `max_workspaces` keep their
  names and their per-workspace/per-account meanings

**`workspace_usage`** — no change.

**`usage_events.resource_type`** — add `'POST'` to the union for error messages.
No new rows are written for posts; the queue check is a live query.

### Plan tiers

| Plan | Price | Workspaces | Channels/ws | Members/ws | Queued posts/channel |
|---|---|---|---|---|---|
| FREE | $0 | 1 | 3 | 1 | 10 |
| BASIC | $5 | 1 | 5 | 2 | -1 |
| PRO | $15 | 3 | 8 | 5 | -1 |
| MAX | $50 | 10 | 25 | 25 | -1 |

Add-ons: `EXTRA_WORKSPACE` (empty), `EXTRA_CHANNEL`, `EXTRA_MEMBER`.

### Limit resolution

Two pure functions carry the logic, so it is testable without a database:

```ts
resolveWorkspaceLimits(plan, addons): { channelsLimit, membersLimit, queuedPostsPerChannel }
canQueuePost(queuedPostsPerChannel, currentQueued): boolean   // -1 ⇒ always true
```

The queue check at schedule time.

**Note on the data shape — this drove the query design.** There is no
`post_targets` table. A post's channels live in `posts.targets`, a **jsonb array**
of `PostTarget { channelId, platform, status, ... }` (`posts.schema.ts:52`), and
each target carries its *own* status alongside the post-level `posts.status`.
Counting "queued posts for channel X" therefore means counting posts whose
`targets` array contains an entry for that channel in `scheduled` status — a
jsonb containment query, not a column filter:

```ts
// Count posts still queued for one channel.
// Post-level status gates the row; the jsonb target carries the channel.
const [{ n }] = await db.select({ n: count() }).from(posts)
  .where(and(
    eq(posts.workspaceId, workspaceId),
    eq(posts.status, 'scheduled'),
    sql`${posts.targets} @> ${JSON.stringify([{ channelId }])}::jsonb`,
  ));

if (!canQueuePost(limit, n)) throw new ForbiddenException(...);
```

Publishing flips `posts.status` out of `scheduled`, which frees the slot with no
bookkeeping.

A partially-published post (`posts.status = 'partially_published'`) is not
counted as queued: the post-level status has already left `scheduled`, so its
remaining targets do not hold slots. This is deliberate — the alternative
(counting per-target status inside the jsonb) would hold a slot open on a post
the user considers sent.

**Index:** add a GIN index on `posts.targets` if the count shows up slow. Do not
add it pre-emptively — measure first; the query is also bounded by
`workspaceId` + `status`, which existing indexes already narrow.

### Call-site changes

`subscriptions` is referenced by 21 non-spec files. The ones that change are
those that look a subscription up *by workspace*:

- `usage.service.ts` — the `getWorkspaceLimits` loop disappears; one lookup by
  `userId`. `getWorkspaceUsage` keeps reading `workspace_usage` unchanged.
- `subscription.service.ts`, `plan-change.service.ts`, `addon.service.ts`,
  `invoice.service.ts`, `dashboard.service.ts`, `webhook.service.ts` — lookups
  move from `workspaceId` to `userId`
- `workspace.service.ts` — on create, seed the new workspace's `workspace_usage`
  from the owner's subscription
- `workspace-suspended.guard.ts`, `ai-token.service.ts`, `admin.service.ts` —
  resolve through the workspace owner

Files that merely *read* `workspace_usage` are untouched.

## Scope

### In

- Schema migration + reseeded plans
- Account-scoped subscription lookups across the billing module
- `EXTRA_WORKSPACE` granting an empty workspace
- Queued-post limit enforcement at schedule time
- Frontend: billing UI, plan cards, usage displays, and the new limit copy

### Out

- Lemon Squeezy / any second provider (separate effort; this spec only makes
  `stripe_customer_id` nullable so that effort needs no second migration)
- Migrating real paying customers (none exist)
- Changing what a workspace *is* — only who pays for it

## Testing

Pure, DB-free unit tests carry the risk:

- `resolveWorkspaceLimits` — base plan alone; plan + each add-on type; add-ons
  stacking; unlimited (`-1`) passthrough
- `canQueuePost` — under limit, at limit, over limit, and `-1` unlimited
- A regression test that a second workspace owned by the same user resolves to
  **the same** subscription (the bug the old loop allowed)

Integration-level: creating a workspace beyond `maxWorkspaces` is refused;
scheduling past the queue limit is refused; publishing frees a slot.

## Risks

| Risk | Mitigation |
|---|---|
| 21 files reference `subscriptions` | Change only the by-workspace lookups; leave `workspace_usage` readers alone |
| A workspace with no `workspace_usage` row | Seed it at workspace creation from the owner's subscription; treat a missing row as FREE rather than throwing |
| Truncate loses data | Verified: 2 subscriptions, Stripe **test mode**, team's own accounts. If a live-mode subscription ever exists, this plan must change |
| Queue count drifts | It cannot — it is a live query over `scheduled` rows, not a stored counter |
| Frontend still assumes per-workspace billing | Frontend is in scope; billing UI updates with the backend |

## References

- [Buffer vs Hootsuite pricing 2026](https://buffer.com/resources/buffer-vs-hootsuite/) — channel-based vs per-seat billing units
- [Buffer review 2026](https://use-apify.com/blog/buffer-review) — free tier caps *queued* posts per channel, slot frees on publish
- [Social media tool pricing compared 2026](https://presly.ai/blog/social-media-tools-pricing-compared-2026) — billing units across Buffer, Publer, SocialPilot, Hootsuite, Sprout, Metricool
