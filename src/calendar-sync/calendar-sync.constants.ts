// =============================================================================
// Calendar Two-Way Sync — constants
// =============================================================================

// BullMQ queue names. Webhooks + the repeatable poll enqueue reconcile jobs;
// the renewal queue keeps provider watches/subscriptions from expiring.
export const CALENDAR_RECONCILE_QUEUE = 'calendar-reconcile';
export const CALENDAR_RENEWAL_QUEUE = 'calendar-renewal';

// -----------------------------------------------------------------------------
// Event ownership tags. Every event we write carries these private props so
// two-way write-back only ever touches events we created.
//
//   post event:     schedura_post_id    + schedura_workspace_id
//   message event:  schedura_message_id + schedura_workspace_id
//
//   Google:  extendedProperties.private[<prop>]
//   Graph:   a singleValueExtendedProperties entry keyed by the matching
//            GRAPH_*_PROP_ID named MAPI property.
//
// BACKWARD COMPATIBILITY: `schedura_post_id` is LOAD-BEARING — live events in
// real users' calendars already carry it (and live `calendar_item_links` rows
// point at them). It must never be renamed or re-keyed. The message tag is a
// NEW, PARALLEL prop; posts keep using exactly what they use today.
// -----------------------------------------------------------------------------
export const SCHEDURA_POST_ID_PROP = 'schedura_post_id';
export const SCHEDURA_MESSAGE_ID_PROP = 'schedura_message_id';
export const SCHEDURA_WORKSPACE_ID_PROP = 'schedura_workspace_id';

// Microsoft Graph named MAPI property (fixed GUID + name). Used as the
// PropertyId when reading/writing the post-id tag via singleValueExtendedProperties.
export const GRAPH_POST_ID_PROP_ID =
  'String {a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c} Name schedura_post_id';

// Same GUID, new name — the message-id counterpart of GRAPH_POST_ID_PROP_ID.
// Reusing the property-set GUID keeps all Schedura tags in one MAPI namespace.
export const GRAPH_MESSAGE_ID_PROP_ID =
  'String {a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c} Name schedura_message_id';

// Companion named MAPI property carrying the owning workspace id. Written
// alongside GRAPH_POST_ID_PROP_ID / GRAPH_MESSAGE_ID_PROP_ID so Graph events
// mirror Google's two private props.
export const GRAPH_WORKSPACE_ID_PROP_ID =
  'String {a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c} Name schedura_workspace_id';

// Default interval for the repeatable reconcile poll (safety net alongside
// provider webhooks): 15 minutes.
export const DEFAULT_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

// -----------------------------------------------------------------------------
// Webhook-triggered reconcile coalescing.
//
// Both providers send ONE notification PER CHANGED EVENT, so a single bulk
// action (importing 200 events, deleting a recurring series) fans out into
// hundreds of notifications within seconds. Each reconcile is a FULL delta pull,
// so 1 notification == 1 job would amplify a burst into hundreds of redundant
// provider round-trips.
//
// Instead the webhook enqueues into a 30s time bucket with a deterministic
// per-channel jobId AND a matching delay: BullMQ drops every duplicate jobId
// while the job sits in the delayed set, so a burst collapses into exactly ONE
// pull that runs once the burst has settled.
// -----------------------------------------------------------------------------
export const CALENDAR_WEBHOOK_DEBOUNCE_MS = 30 * 1000;

// -----------------------------------------------------------------------------
// BullMQ job names (one per queue — `job.name` guards in the processors).
// -----------------------------------------------------------------------------
export const CALENDAR_RECONCILE_JOB = 'reconcile';
export const CALENDAR_RENEWAL_JOB = 'renew-due';

// Cron for the reconcile poll. Kept in lockstep with
// DEFAULT_RECONCILE_INTERVAL_MS (15 min) — that constant is also the dedupe
// bucket for the per-channel jobId.
export const CALENDAR_RECONCILE_CRON = '*/15 * * * *';
// Renewal sweep runs hourly — comfortably inside both providers' safety windows.
export const CALENDAR_RENEWAL_CRON = '0 * * * *';

// -----------------------------------------------------------------------------
// Provider push-subscription lifetimes + renewal safety windows.
//
//   Google  — an events `watch` channel cannot be renewed; it is stopped and
//             re-created. Default TTL is 7 days; we re-arm with >24h to spare.
//   Graph   — a `/me/events` subscription maxes out at 4230 minutes (~2.9 days)
//             and IS renewable via PATCH; we re-arm with >12h to spare.
// -----------------------------------------------------------------------------
export const GOOGLE_WATCH_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800
export const GOOGLE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GRAPH_SUBSCRIPTION_TTL_MINUTES = 4230;
export const GRAPH_RENEWAL_WINDOW_MS = 12 * 60 * 60 * 1000;

// Provider change-notification callback paths (mounted by CalendarWebhookController).
export const GOOGLE_WEBHOOK_PATH = '/calendar-sync/webhooks/google';
export const OUTLOOK_WEBHOOK_PATH = '/calendar-sync/webhooks/outlook';
