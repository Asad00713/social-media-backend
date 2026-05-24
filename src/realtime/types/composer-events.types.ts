import type { PublishStatus, PublishErrorCode } from '../../posts/composer/types/draft.types';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface ComposerPublishStateChangedPayload {
  workspaceId: string;
  draftId: string;
  channelId: string;
  platform: SupportedPlatform;
  status: PublishStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  errorCode?: PublishErrorCode;
  errorMessage?: string;
  attemptedAt: string;
  retryCount: number;
}

export interface ComposerDraftStatusChangedPayload {
  workspaceId: string;
  draftId: string;
  status: 'publishing' | 'published' | 'partial_success' | 'failed';
  updatedAt: string;
}
