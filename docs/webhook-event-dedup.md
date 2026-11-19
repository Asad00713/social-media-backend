# Webhook event dedup — both providers

Phase 2 item #6 of the production-readiness audit, as the code actually turned
out to be. Both providers stay in service: Lemon Squeezy bills today, and
Stripe takes over for new billing once it exists, so neither gate may be left
half-right.

## What the audit said, and what the code said

> #6 — Lemon Squeezy webhook event dedup. Stripe is correct
> (`UNIQUE stripe_event_id`); Lemon Squeezy has none.

Both halves were wrong.

### Lemon Squeezy already dedups — per side effect, not per event

`lemonsqueezy-webhook.service.ts` has no event-level gate, and cannot have one:

- The [official docs](https://docs.lemonsqueezy.com/help/webhooks/webhook-requests)
  list exactly three headers — `Content-Type`, `X-Event-Name`, `X-Signature`.
- `meta` carries `event_name` and `custom_data`. Nothing else.
- `data.id` is the **resource** id (the subscription, or the invoice), not an
  id for the delivery.

So a Stripe-style `UNIQUE(event_id)` table is not buildable here: there is no
event id to key it on. The idempotency key has to be synthesised from the
payload, which is what this service already does, at each place where a repeat
would be visible:

| Side effect | What makes a redelivery harmless |
|---|---|
| In-app alert / toast | `billing_payment_alerts.alert_key` is UNIQUE; the claim is `INSERT .. ON CONFLICT DO NOTHING` |
| Payment-failed email | `billingEmailKey('payment-failed', 'ls', invoiceId, attempt)`, where `attempt` is the invoice's `updated_at` — it moves on each real retry and is identical on a redelivery of one |
| Provider row writes | `onConflictDoUpdate` on `(subscription_id, provider, item_type)`; `is_default` deliberately absent from the update set |
| Quantity | assigned absolutely from the payload (`providerQuantity = first_subscription_item.quantity`), never incremented, so it cannot double |
| Status writes | terminal statuses refuse to move out of themselves, so a late event cannot resurrect a dead row |
| Recovery announcement | the `past_due -> active` update is conditional, so exactly one caller sees the transition |

This is deliberate, not accidental — the file says so in its own comments
("a redelivery must never move the flag", "identical on a redelivery of the
same one").

### Stripe's gate was the broken one

`webhook.service.ts` opened with:

```ts
const existingEvent = await db.select().from(billingEvents)
  .where(eq(billingEvents.stripeEventId, event.id)).limit(1);
if (existingEvent.length > 0) return;
await db.insert(billingEvents).values({ ... processed: false });
```

Check-then-act, across two statements, on a column that has carried
`billing_events_stripe_event_id_unique` since migration 0003. **The gate never
used the constraint.** Two bugs came out of those four lines.

## Bug 1 — two concurrent deliveries both run the handler

Proven against a real Postgres, two connections, one event id:

```
OLD gate (select, then insert)  : PROCESSED | CRASH 23505
NEW gate (insert .. on conflict): PROCESSED | skipped
```

Both deliveries passed the SELECT, both ran the handler, and the loser then
raised 23505 — a 500, which is itself a response Stripe retries. Stripe
redelivers on any non-2xx and the route is held open for the whole handler, so
a slow handler makes the overlap ordinary rather than rare.

This is the same shape as the usage-counter race (BE #245): a read and a write
that must be one statement.

## Bug 2 — a FAILED event was never retried

The gate tested **existence**. The catch block recorded the error and rethrew,
so Stripe would retry — but the row was already there with
`processed = false`, so that retry hit the gate and returned early.

And nothing ever replays such a row: `processed` is written in exactly one
place and read in none. So a transient failure during `invoice.paid` meant
that payment was **never applied, silently and permanently**.

## The fix

The insert IS the gate:

```ts
const claimed = await db.insert(billingEvents)
  .values({ ... processed: false })
  .onConflictDoNothing({ target: billingEvents.stripeEventId })
  .returning({ id: billingEvents.id });

if (claimed.length === 0) return;   // someone else owns this event
```

and a handler that throws **releases** its claim, so Stripe's next delivery can
take the event. `errorMessage` is no longer written on that path: a column on a
row about to be deleted records nothing, and the failure is already logged with
its stack. The table goes back to being what its only reader treats it as — the
log of events that **succeeded**.

A release that itself fails is logged loudly, because it means a dropped event
that must be replayed by hand.

## Why no migration

`billing_events_stripe_event_id_unique` already exists
(`drizzle/migrations/0003_ordinary_thena.sql:24`). The constraint was there all
along; only the gate ignored it.

## Tests

`webhook.event-claim.spec.ts` (8 tests). Its `db` fake **enforces** the unique
constraint, because the sibling specs' fake implements `onConflictDoNothing` as
a no-op returning the chain and `returning()` as "the last row inserted" —
under that fake every claim looks like it succeeded and the central assertion
would pass whether the fix works or not. A SELECT throws there, since the gate
must no longer issue one.

`webhook.payment-alerts.spec.ts`'s fake was extended the same way: its
"a redelivered event alerts nothing (billing_events stops it first)" test was
passing because the fake pushed unconditionally. It now proves the real
behaviour.

Mutation-tested, against the source:

| Mutation | Tests that fail |
|---|---|
| remove `onConflictDoNothing` | 3 |
| remove the claim release | 1 |

## What the release exposed — `failed_payments`

Found in independent review of this change, and fixed in the same PR.

Releasing the claim is what makes a retry possible, and a retry re-runs the
handler **from the top**. So every write a handler performs before a later
`await` can now happen twice, and each one needs a key of its own.

`handleInvoicePaymentFailed` had exactly one that did not:

```ts
await db.insert(failedPayments).values(failedPayment);   // no key, no constraint
```

`failed_payments` carried a bigserial primary key and **no unique constraint of
any kind**, and this insert sits before roughly eight further await points,
several of which write (`applyPaymentFailureRestrictions`, the
`workspaceUsage` fan-out, the `subscriptions` status flip, the alert).

That is not a cosmetic duplicate, because the dunning gate counts **rows**:

```ts
if (unresolvedFailures.length >= this.MAX_FAILED_ATTEMPTS)   // 3
  await this.applyPaymentFailureRestrictions(...);
```

A customer with two genuine failures plus one duplicated retry reads as three
and has every owned workspace dropped to FREE limits with all purchased add-ons
zeroed — **a full failure early, from a transient database error.** The
duplicates also skew `startsEpisode`'s `Math.min` over unresolved ids, which
decides whether the "moved to Free" email goes out for that episode.

The old code hid this by accident: the stale `processed = false` row blocked the
retry entirely. The fix trades silent event loss for duplicated appends, so the
append needs the same treatment the gate got — migration 0089 adds
`failed_payments.stripe_event_id` with a partial unique index, and the insert
claims it. The handler already had `eventId` in hand; it was using it for the
alert key.

### The partial index needs its predicate named

Postgres will **not** infer a partial index from a bare `ON CONFLICT (col)`:

```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

That error would have 500'd **every** payment failure in production. Verified
against Postgres both ways, with Drizzle's exact emission:

```
ON CONFLICT (stripe_event_id) DO NOTHING                               -> ERROR
ON CONFLICT (stripe_event_id) WHERE stripe_event_id IS NOT NULL ... -> works
```

So the insert passes `where: sql`...IS NOT NULL`` — Drizzle renders that as
`(col) where <predicate> do nothing`, which is the index-predicate position the
inference needs. The index is partial, and the column nullable, because rows
written before 0089 have no event id, and under a *plain* unique index every
NULL is distinct in Postgres — which would permit the very duplicates this
forbids while appearing to prevent them.

Proven on a real database:

```
first    : inserted
retry    : skipped      <- no duplicate dunning row
NULL #1  : inserted
NULL #2  : inserted     <- legacy rows stay unconstrained
```

### A stale comment that made the bug look safe

The alert claim's comment read *"Redelivery of the same event is stopped
earlier by the billing_events check."* After this change that is true only of a
redelivery of a **succeeded** event — a handler that throws now releases its
claim on purpose. That sentence was the reasoning that made the unguarded
insert look safe, so it is corrected rather than left to mislead the next
reader. A regression test asserts it does not come back.

### Also from the review

`webhook.payment-alerts.spec.ts`'s fake had no `delete:` method. No test there
drives a throwing handler today, so nothing reached the release path — but the
release is wrapped in its own try/catch in production, so a future failure test
would have had its `db.delete is not a function` **swallowed** and would have
looked like it passed while the release never happened. The fake now has one.

Verified as non-issues: `.returning()` semantics on conflict (drizzle 0.45.0 +
pg 8), the claim's scope and the unchanged 200-response timing (one round trip
faster, in fact), and the audit-trail loss — nothing in the backend, the admin
app, or either frontend reads `billing_events.errorMessage` or `processed`.
