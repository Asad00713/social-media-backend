// =============================================================================
// Calendar Two-Way Sync — constants
// =============================================================================

// BullMQ queue names. Webhooks + the repeatable poll enqueue reconcile jobs;
// the renewal queue keeps provider watches/subscriptions from expiring.
export const CALENDAR_RECONCILE_QUEUE = 'calendar-reconcile';
export const CALENDAR_RENEWAL_QUEUE = 'calendar-renewal';

// -----------------------------------------------------------------------------
// Event ownership tags. Every post-event we write carries these private props so
// two-way write-back only ever touches events we created.
//   Google:  extendedProperties.private[SCHEDURA_POST_ID_PROP]
//   Graph:   a singleValueExtendedProperties entry keyed by GRAPH_POST_ID_PROP_ID
// -----------------------------------------------------------------------------
export const SCHEDURA_POST_ID_PROP = 'schedura_post_id';
export const SCHEDURA_WORKSPACE_ID_PROP = 'schedura_workspace_id';

// Microsoft Graph named MAPI property (fixed GUID + name). Used as the
// PropertyId when reading/writing the post-id tag via singleValueExtendedProperties.
export const GRAPH_POST_ID_PROP_ID =
  'String {a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c} Name schedura_post_id';

// Companion named MAPI property carrying the owning workspace id. Written
// alongside GRAPH_POST_ID_PROP_ID so Graph events mirror Google's two private
// props (schedura_post_id + schedura_workspace_id).
export const GRAPH_WORKSPACE_ID_PROP_ID =
  'String {a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c} Name schedura_workspace_id';

// Default interval for the repeatable reconcile poll (safety net alongside
// provider webhooks): 15 minutes.
export const DEFAULT_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
