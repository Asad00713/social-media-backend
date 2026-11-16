/**
 * The notification catalogue: the single source of truth for which events can
 * notify, on which channel, with what default and whether the switch is locked.
 * A stored preference row only OVERRIDES these defaults, and adding an event
 * needs no migration (the DTO validates against NOTIFICATION_EVENT_KEYS).
 * The ids that overlap the frontend's old ids keep them: they are a stable
 * contract.
 */
export const NOTIFICATION_EVENT_KEYS = [
  'post_failed',
  'channel_health',
  'drip_review',
  'approval_request',
  'post_approved',
  'draft_ready',
  'member_activity',
  'inbox_assigned',
  'inbox_mention',
  'inbox_new_message',
  'billing_alert',
  'security_alert',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/** `inactivity_reminder` is account-level: it is not in the workspace matrix. */
export type PreferenceEventKey = NotificationEventKey | 'inactivity_reminder';

export type PreferenceChannel = 'email' | 'app';

/** A channel an event uses. `locked` means the member cannot turn it off. */
export interface ChannelRule {
  default: boolean;
  locked: boolean;
}

export interface NotificationEventDef {
  key: PreferenceEventKey;
  label: string;
  /** `account` events carry no workspace and are never listed per workspace. */
  scope: 'workspace' | 'account';
  /** null = the event never uses this channel. */
  email: ChannelRule | null;
  app: ChannelRule | null;
}

export interface ChannelPreference {
  enabled: boolean;
  locked: boolean;
}

export interface NotificationPreferenceDto {
  event: NotificationEventKey;
  /** null = this event never emails. */
  email: ChannelPreference | null;
  /** null = this event has no in-app notification. */
  app: ChannelPreference | null;
}

export interface NotificationPreferencesResponse {
  workspaceId: string;
  events: NotificationPreferenceDto[];
}

export interface PreferenceChange {
  event: NotificationEventKey;
  channel: PreferenceChannel;
  enabled: boolean;
}

const on: ChannelRule = { default: true, locked: false };
const off: ChannelRule = { default: false, locked: false };
const onLocked: ChannelRule = { default: true, locked: true };

function def(
  key: PreferenceEventKey,
  label: string,
  email: ChannelRule | null,
  app: ChannelRule | null,
  scope: 'workspace' | 'account' = 'workspace',
): NotificationEventDef {
  return { key, label, scope, email, app };
}

/**
 * Events listed in the workspace matrix but stored at account level
 * (`workspace_id IS NULL`): a security alert is about the person, not a
 * workspace, and A5/A6 read the account-level row. A PUT for any workspace
 * writes that row, and every workspace's GET reads it.
 */
export const ACCOUNT_STORED_EVENTS: ReadonlySet<PreferenceEventKey> = new Set([
  'security_alert',
]);

/** Where `event`'s override row lives for a request about `workspaceId`. */
export function storageWorkspaceId(
  event: PreferenceEventKey,
  workspaceId: string | null,
): string | null {
  return ACCOUNT_STORED_EVENTS.has(event) ? null : workspaceId;
}

/** In display order: `list` returns the workspace-scope events in this order. */
export const NOTIFICATION_EVENTS: Record<
  PreferenceEventKey,
  NotificationEventDef
> = {
  post_failed: def('post_failed', 'Post failed', on, onLocked),
  channel_health: def('channel_health', 'Channel disconnected', on, onLocked),
  drip_review: def('drip_review', 'Drip post to review', on, null),
  approval_request: def('approval_request', 'Approval requested', on, on),
  post_approved: def('post_approved', 'Post approved', on, on),
  draft_ready: def('draft_ready', 'Draft ready', null, on),
  member_activity: def('member_activity', 'Member joined', off, on),
  inbox_assigned: def('inbox_assigned', 'Conversation assigned', on, on),
  inbox_mention: def('inbox_mention', 'Mentioned in a note', on, on),
  inbox_new_message: def('inbox_new_message', 'New inbox message', on, on),
  billing_alert: def('billing_alert', 'Billing', onLocked, on),
  security_alert: def('security_alert', 'Security', onLocked, on),
  inactivity_reminder: def(
    'inactivity_reminder',
    'Inactivity reminders',
    on,
    null,
    'account',
  ),
};
