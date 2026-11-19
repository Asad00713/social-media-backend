/**
 * Replay keys for inbound webhook deliveries.
 *
 * ## What was and was not already protected
 *
 * Every webhook here verifies its signature (`X-Hub-Signature-256`,
 * timing-safe, per-source secret), so a forged delivery is refused. A
 * signature says nothing about *freshness*, though: it is computed over the
 * body alone, so a delivery captured once stays valid forever and can be
 * sent again.
 *
 * Most of what that could cause was already impossible, which is why this
 * module is small. Checked path by path:
 *
 * | Path | Already idempotent? |
 * |---|---|
 * | inbox comments and DMs | yes — unique upsert on `(channelId, platformItemId)` |
 * | WhatsApp ingest | yes — goes through `upsertDm` |
 * | Telegram inbox | yes — same upsert, keyed on `message_id` |
 * | Meta Ads `leadgen` | yes — `onConflictDoNothing()` on `meta_leadgen_id` |
 * | Slack events | yes — `jobId: payload.event_id` |
 * | **Maestro bridge** | **no** |
 *
 * The bridge is the gap, and it is the worst one to have: it runs an AI agent
 * and sends a reply. A replayed delivery makes Maestro answer the same
 * message a second time — real token spend, and the person receives the
 * answer twice. Nothing downstream could catch it, because "send a message"
 * has no natural unique row to conflict on.
 *
 * ## Why BullMQ's `deduplication` and not `jobId`
 *
 * Slack's existing `jobId: event_id` works there because that queue keeps its
 * completed jobs. Both bridge enqueues pass `removeOnComplete: true`, and a
 * removed job frees its id — so a `jobId` would stop a *concurrent* duplicate
 * and then forget, which is exactly the window a replay uses.
 *
 * `deduplication: { id, ttl }` writes a **separate** Redis key:
 *
 *     SET <dedup key> <jobId> PX <ttl> NX
 *
 * (`commands/includes/deduplicateJob.lua`). It outlives the job, and being a
 * single `SET … NX` it is atomic — no check-then-act window, the property
 * that mattered in the Stripe webhook gate (BE #246).
 */

/**
 * How long a delivery is remembered.
 *
 * Telegram retries an update for about 24 hours and Meta retries for several,
 * so the window has to cover a legitimate retry or dedup would defeat the
 * platform's own delivery guarantee. 24h covers both, and the keys are small
 * and expire themselves.
 */
export const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/** BullMQ's option bag for one deduplicated delivery. */
export interface WebhookDedup {
  deduplication: { id: string; ttl: number };
}

/**
 * The dedup option for a delivery, or `{}` when the payload carries no stable
 * id.
 *
 * Returning `{}` rather than inventing a key is deliberate. A hash of the body
 * would look like an id and behave differently: two genuinely distinct events
 * that happen to serialise identically would collapse into one, which loses a
 * real message. Letting an id-less delivery through unchanged keeps today's
 * behaviour for a payload shape we do not recognise, instead of silently
 * dropping it.
 */
export function dedupById(
  id: string | number | undefined | null,
): WebhookDedup | Record<string, never> {
  if (id === undefined || id === null) return {};
  const key = String(id).trim();
  if (!key) return {};
  return { deduplication: { id: key, ttl: WEBHOOK_DEDUP_TTL_MS } };
}

/**
 * Telegram's own idempotency key for an update.
 *
 * Telegram documents `update_id` as unique per update and resends the same
 * one until the webhook answers 2xx, so it is precisely the key this needs —
 * and it was being discarded: `grep -rn "update_id" src` found no uses before
 * this change.
 */
export function telegramUpdateDedup(
  update: unknown,
): WebhookDedup | Record<string, never> {
  const id = (update as { update_id?: number } | null)?.update_id;
  return dedupById(id === undefined ? undefined : `tg-${id}`);
}

/**
 * The first WhatsApp message id in a delivery (`wamid...`), which Meta keeps
 * stable across its retries.
 *
 * One delivery can carry several messages; the first id identifies the
 * delivery, which is the unit being enqueued. A payload with no messages (a
 * status-only delivery) has no id and is left alone — those are handled
 * before this point anyway.
 */
export function whatsappDeliveryDedup(
  messageIds: readonly string[],
): WebhookDedup | Record<string, never> {
  const first = messageIds.find((id) => id && id.trim().length > 0);
  return dedupById(first === undefined ? undefined : `wa-${first}`);
}
