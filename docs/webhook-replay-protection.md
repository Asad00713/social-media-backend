# Webhook replay protection

Phase 3 audit item #8. The audit framed this as a system-wide hole; it is not.
Four of the five side-effect paths were already idempotent, and the one that
was not is the worst one to have been missing.

## What a signature does and does not say

Every webhook route verifies its delivery: `X-Hub-Signature-256` against the
endpoint's app secret, timing-safe (`common/utils/webhook-signature.util.ts`),
with per-source secrets. A forged delivery is refused with 401.

A signature is computed over the **body alone**. It carries no timestamp and
no nonce, so a delivery captured once stays valid forever — Meta's scheme has
no equivalent of Stripe's `t=` timestamp to bound it. Replay protection
therefore has to come from recognising the event, not from the signature.

## Most of it was already covered

Checked path by path, because the audit's framing implied otherwise:

| Path                | Already idempotent | How                                                                                                |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| inbox comments, DMs | ✅                 | unique upsert on `(channelId, platformItemId)`                                                     |
| WhatsApp ingest     | ✅                 | routes through `upsertDm`, same upsert                                                             |
| Telegram inbox      | ✅                 | same upsert, keyed on `message_id`                                                                 |
| Meta Ads `leadgen`  | ✅                 | `onConflictDoNothing()` on `meta_leadgen_id` — the code even says _"deduplicates webhook replays"_ |
| Slack events        | ✅                 | `jobId: payload.event_id` — _"dedupe — Slack retries on non-2xx"_                                  |
| **Maestro bridge**  | ❌                 | —                                                                                                  |

Slack's line is worth noting: the pattern was already in the codebase, so none
of this needed inventing.

## The gap: the Maestro bridge

`maestro/bridge/processors/maestro-bridge.processor.ts` **runs an AI agent and
sends a reply**. A replayed delivery makes Maestro answer the same message a
second time:

- real token spend, charged to us;
- the person receives the answer twice.

Nothing downstream could catch it, because "send a message" has no natural
unique row to conflict on — unlike a comment, which collides on its platform
id.

And the key was there all along: **`grep -rn "update_id" src` returned nothing
before this change.** Telegram documents `update_id` as unique per update and
resends the same one until the webhook answers 2xx. It was being discarded.

## Why BullMQ's `deduplication` and not `jobId`

`jobId` is the obvious choice and it is wrong here. Both bridge enqueues pass
`removeOnComplete: true`, and a removed job frees its id — so a `jobId` stops
a _concurrent_ duplicate and then forgets, which is exactly the window a
replay arrives in. Slack can use `jobId` because that queue keeps its
completed jobs.

`deduplication: { id, ttl }` writes a separate Redis key. From
`bullmq/commands/includes/deduplicateJob.lua`:

```lua
deduplicationKeyExists = not rcall('SET', deduplicationKey, jobId, 'PX', ttl, 'NX')
```

Two properties matter:

- **it outlives the job** — the key is its own, not a field on the job hash,
  so `removeOnComplete` does not clear it;
- **it is atomic** — a single `SET … NX`, so there is no check-then-act
  window. That is the same property the Stripe webhook gate turned on
  (`webhook-event-dedup.md`), where a `SELECT` followed by an `INSERT` let
  two concurrent deliveries both pass.

### The TTL is 24 hours

It has to cover a **legitimate** platform retry, or dedup would defeat the
delivery guarantee it is riding on: Telegram retries an update for about a
day, Meta for several hours. The keys are small and expire themselves.

## Keys

| Source       | Key                 | Why                                             |
| ------------ | ------------------- | ----------------------------------------------- |
| Telegram     | `tg-<update_id>`    | Telegram's own per-update id                    |
| WhatsApp     | `wa-<first wamid>`  | Meta keeps the message id stable across retries |
| Meta leadgen | `lead-<leadgen_id>` | the lead's own id                               |

Namespaced on purpose: an unprefixed Telegram `update_id` of `1` and a
WhatsApp id of `1` would be the same Redis key, and one real event would be
dropped as a duplicate of the other.

**A payload with no id gets no dedup, deliberately.** Hashing the body would
look like an id and behave differently: two genuinely distinct events that
serialise identically would collapse into one, losing a real message. An
unrecognised payload keeps today's behaviour instead of being silently
dropped.

`update_id: 0` is a real id. A truthiness check would discard it — that
mutation fails a test.

## Two paths deduplicated for cost, not correctness

`whatsappIngestQueue` and the inbox `telegramQueue` upsert downstream, so a
replay could never duplicate a row. They are keyed anyway: it stops the job
redoing the work, including the profile lookups inside it. The comments at
those sites say which reason applies, so nobody later reads them as the
correctness guard.

## Tests

`webhook-dedup.util.spec.ts` (30). Beyond the key-shape tests, it carries a
**fail-closed net** over the controller: every `<queue>.add(` call must show
either `deduplication`, one of this module's helpers, or an explicit `jobId`.

That net is the reason this document can claim completeness — **and it earned
its place immediately.** The first pass wired two Maestro bridge enqueues and
the spec found a **third**: the dedicated Maestro WhatsApp number has a route
of its own, which I had not noticed. A hand-written list would have passed.
This is the same failure mode as the publishing-path spec in BE #247, which
passed 14/14 while two engines leaked.

The net's own extraction had to be fixed too: it first sliced each call to a
fixed `'\n    );'` terminator, which cut the `leadgen` enqueue short of its
options bag — that call is nested two loops deeper — and reported a
deduplicated call as undeduplicated. It now counts parentheses.

Mutation-tested:

| Mutation                                     | Tests that fail |
| -------------------------------------------- | --------------- |
| drop the `tg-`/`wa-` namespace               | 5               |
| remove dedup from the Maestro Telegram route | 2               |
| truthiness check on `update_id` (drops `0`)  | 1               |
| TTL set to 0                                 | 1               |

## What is deliberately not done

- **No timestamp window.** Meta sends no signed timestamp, so there is nothing
  to compare against. `entry.time` is inside the body and an attacker replays
  the body whole, so rejecting an old `entry.time` would only limit how long a
  captured delivery stays useful — while risking a legitimate retry that
  arrives late. Event identity is the stronger guarantee and it is what the
  platforms already give us.
- **No new table.** The Stripe gate needed one (`billing_events`) because a
  payment event must be auditable. These are inbound messages; a Redis key
  with a TTL is the right weight.
