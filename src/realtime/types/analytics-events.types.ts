import type {
  ComposerPublishStateChangedPayload,
  ComposerDraftStatusChangedPayload,
} from './composer-events.types';

export type AnalyticsEventName =
  | 'channel.snapshot.updated'
  | 'post.metrics.updated'
  | 'channel.sync.state.changed'
  | 'composer.publish.state.changed'
  | 'composer.draft.status.changed'
  | 'post.status.changed'
  | 'inbox.item.created'
  | 'inbox.item.updated'
  | 'inbox.counts.changed'
  | 'scheduled.message.created'
  | 'scheduled.message.updated'
  | 'scheduled.message.cancelled'
  | 'scheduled.message.sent'
  | 'scheduled.message.failed'
  | 'ad_account.connected'
  | 'ad.status.changed'
  | 'ad.insights.updated'
  | 'lead.created'
  | 'lead.delivered'
  | 'maestro.bridge.message';

export interface ChannelSnapshotUpdatedPayload {
  workspaceId: string;
  channelId: number;
  platform: string;
  snapshotDate: string;
  followersCount: number | null;
  totalPostsCount: number | null;
  platformMetrics: Record<string, unknown>;
  fetchedAt: string;
}

export interface PostMetricsUpdatedPayload {
  workspaceId: string;
  channelId: number;
  postId: string;
  ageBucket: string;
  likesCount: number | null;
  commentsCount: number | null;
  sharesCount: number | null;
  impressionsCount: number | null;
  fetchedAt: string;
}

export interface ChannelSyncStateChangedPayload {
  workspaceId: string;
  channelId: number;
  status: 'healthy' | 'catching_up' | 'rate_limited' | 'failing' | 'paused';
  lastSyncedAt: string | null;
  consecutiveFailures: number;
}

export type PostLifecycleStatus =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'partially_published';

export interface PostStatusChangedTarget {
  channelId: string;
  platform: string;
  status: PostLifecycleStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedAt?: string;
  errorMessage?: string;
}

export interface PostStatusChangedPayload {
  workspaceId: string;
  postId: string;
  previousStatus: PostLifecycleStatus;
  status: PostLifecycleStatus;
  targets: PostStatusChangedTarget[];
  publishedAt: string | null;
  lastError: string | null;
  updatedAt: string;
  triggeredBy: 'user' | 'scheduler';
  triggeredByUserId: string | null;
}

export type InboxItemType = 'comment' | 'dm';
export type InboxItemStatus = 'unread' | 'needs_reply' | 'replied' | 'done';

export interface InboxItemEventBase {
  id: string;
  workspaceId: string;
  channelId: number;
  platform: string;
  type: InboxItemType;
  platformItemId: string;
  platformParentId: string | null;
  platformPostId: string | null;
  /** Populated for DMs only — `<pageId>:<otherPartyPsid>` style. Null for comments. */
  conversationId?: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  text: string | null;
  status: InboxItemStatus;
  fromMe: boolean;
  platformCreatedAt: string;
}

export interface InboxItemCreatedPayload extends InboxItemEventBase {}

export interface InboxItemUpdatedPayload {
  id: string;
  workspaceId: string;
  channelId: number;
  changes: Partial<{
    status: InboxItemStatus;
    repliedAt: string | null;
    repliedByUserId: string | null;
  }>;
}

export interface InboxCountsChangedPayload {
  workspaceId: string;
  perChannel: { channelId: number; comments: number; dms: number }[];
  smartFolders: {
    all: number;
    unread: number;
    needs_reply: number;
    done: number;
  };
}

export type ScheduledInboxLifecycleStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface ScheduledInboxEventBase {
  id: string;
  workspaceId: string;
  channelId: number;
  type: 'comment' | 'dm';
  threadKey: string;
  status: ScheduledInboxLifecycleStatus;
  scheduledAt: string;
  textPreview: string;
  targetLabel: string | null;
  parentItemId?: string | null;
  platformPostId?: string | null;
  conversationId?: string | null;
}

export interface ScheduledInboxCreatedPayload extends ScheduledInboxEventBase {}
export interface ScheduledInboxUpdatedPayload extends ScheduledInboxEventBase {}
export interface ScheduledInboxCancelledPayload {
  id: string;
  workspaceId: string;
  channelId: number;
  threadKey: string;
}
export interface ScheduledInboxSentPayload extends ScheduledInboxEventBase {
  inboxItemId: string | null;
}
export interface ScheduledInboxFailedPayload extends ScheduledInboxEventBase {
  errorMessage: string;
}

export interface AdAccountConnectedPayload {
  workspaceId: string;
  adAccountId: string;
  name: string;
  currency: string;
}

export interface AdStatusChangedPayload {
  workspaceId: string;
  campaignId: string;
  entity: 'campaign' | 'adset' | 'ad';
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}

export interface AdInsightsUpdatedPayload {
  workspaceId: string;
  campaignId: string;
  date: string;
}

export interface LeadCreatedPayload {
  workspaceId: string;
  leadId: string;
  leadFormId: string;
  capturedAt: string;
}

export interface LeadDeliveredPayload {
  workspaceId: string;
  leadId: string;
  destination: 'inbox' | 'email' | 'webhook';
  success: boolean;
  error?: string;
}

/** A Maestro turn arrived from an external bridge channel (Telegram/WhatsApp) —
 *  signals an open Maestro panel on the same conversation to refresh live. */
export interface MaestroBridgeMessagePayload {
  workspaceId: string;
  conversationId: string;
  channel: 'telegram' | 'whatsapp';
}

export type AnalyticsEventPayloadMap = {
  'channel.snapshot.updated': ChannelSnapshotUpdatedPayload;
  'post.metrics.updated': PostMetricsUpdatedPayload;
  'channel.sync.state.changed': ChannelSyncStateChangedPayload;
  'composer.publish.state.changed': ComposerPublishStateChangedPayload;
  'composer.draft.status.changed': ComposerDraftStatusChangedPayload;
  'post.status.changed': PostStatusChangedPayload;
  'inbox.item.created': InboxItemCreatedPayload;
  'inbox.item.updated': InboxItemUpdatedPayload;
  'inbox.counts.changed': InboxCountsChangedPayload;
  'scheduled.message.created': ScheduledInboxCreatedPayload;
  'scheduled.message.updated': ScheduledInboxUpdatedPayload;
  'scheduled.message.cancelled': ScheduledInboxCancelledPayload;
  'scheduled.message.sent': ScheduledInboxSentPayload;
  'scheduled.message.failed': ScheduledInboxFailedPayload;
  'ad_account.connected': AdAccountConnectedPayload;
  'ad.status.changed': AdStatusChangedPayload;
  'ad.insights.updated': AdInsightsUpdatedPayload;
  'lead.created': LeadCreatedPayload;
  'lead.delivered': LeadDeliveredPayload;
  'maestro.bridge.message': MaestroBridgeMessagePayload;
};
