import type {
  MediaItem,
  PlatformContent,
  PostStatus,
} from '../../drizzle/schema/posts.schema';
import type { PublishErrorCode } from '../composer/types/draft.types';
import type { PostFailure } from '../lib/post-failure';

export interface PlannerUserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface PlannerPostTargetDto {
  channelId: string;
  platform: string;
  /** Normalized: reads status AND publishStatus; published wins over failed. */
  status: PostStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedAt?: string;
  errorMessage?: string;
  errorCode?: PublishErrorCode;
  destination?: { id: string; name?: string };
  contentOverride?: PlatformContent;
  /** Non-null only when status === 'failed'. */
  failure: PostFailure | null;
}

export interface PlannerPostDto {
  id: string;
  workspaceId: string;
  createdById: string;
  content: string | null;
  mediaItems: MediaItem[];
  targets: PlannerPostTargetDto[];
  /** The stored value. */
  status: PostStatus;
  /** Derived: 'partially_published' when targets mix published and failed. */
  displayStatus: PostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  /** publishedAt ?? scheduledAt: the instant the post sits on the calendar. */
  occurredAt: string | null;
  platformContent: Record<string, PlatformContent>;
  metadata: Record<string, unknown> & {
    title?: string;
    hashtags?: string[];
    firstComment?: string;
  };
  campaignId: string | null;
  lastError: string | null;
  retryCount: string | null;
  createdAt: string;
  updatedAt: string;
  author: PlannerUserRef;
  readyAt: string | null;
  readyBy: { id: string; name: string } | null;
}

export interface PlannerCalendarDto {
  posts: PlannerPostDto[];
  /** Keys are yyyy-MM-dd in the workspace time zone. */
  byDate: Record<string, PlannerPostDto[]>;
  total: number;
  /** IANA; an invalid stored zone comes back as 'UTC'. */
  timezone: string;
}
