import type {
  ComposerPublishStateChangedPayload,
  ComposerDraftStatusChangedPayload,
} from './composer-events.types';

export type AnalyticsEventName =
  | 'channel.snapshot.updated'
  | 'post.metrics.updated'
  | 'channel.sync.state.changed'
  | 'composer.publish.state.changed'
  | 'composer.draft.status.changed';

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

export type AnalyticsEventPayloadMap = {
  'channel.snapshot.updated': ChannelSnapshotUpdatedPayload;
  'post.metrics.updated': PostMetricsUpdatedPayload;
  'channel.sync.state.changed': ChannelSyncStateChangedPayload;
  'composer.publish.state.changed': ComposerPublishStateChangedPayload;
  'composer.draft.status.changed': ComposerDraftStatusChangedPayload;
};
