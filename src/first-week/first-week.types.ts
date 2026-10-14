import type { FirstWeekStatus } from '../drizzle/schema/workspace-brand-profile.schema';

/** 'posts' reads published posts first; 'described' skips straight to drafting. */
export type FirstWeekMode = 'posts' | 'described';

/** Statuses a person may retry from (POST /retry). */
export const RETRYABLE_STATUSES: readonly FirstWeekStatus[] = [
  'failed',
  'needs_description',
  'no_tokens',
];

/**
 * A run in `reading` or `drafting` that has not touched its row for this long
 * is treated as stalled (process died before enqueueing, or the job stalled).
 */
export const STALE_RUN_MS = 10 * 60 * 1000;

/** BullMQ job payload. `userId` is who pays and authors; falls back to the workspace owner. */
export interface FirstWeekJobData {
  workspaceId: string;
  mode: FirstWeekMode;
  userId?: string;
}

export interface BrandInput {
  sells: string;
  voice: string[];
  audience: string;
}

export type SkipReason =
  | 'no_targets'
  | 'needs_image'
  | 'past'
  | 'already_scheduled'
  | 'queue_full'
  | 'not_found'
  | 'error';

export interface FirstWeekDraftTarget {
  platform: string;
  channelId: string;
}

export interface FirstWeekDraft {
  id: string;
  /** Anything that has left 'draft' is reported as 'scheduled' (it was committed). */
  status: 'draft' | 'scheduled';
  slot: number;
  suggestedAt: string;
  scheduledAt: string | null;
  caption: string;
  mediaUrl: string | null;
  targets: FirstWeekDraftTarget[];
  schedulable: boolean;
  /** Why it cannot be scheduled right now; null when it can. */
  blockedReason: SkipReason | null;
}

export interface FirstWeekProfileView {
  sells: string | null;
  voice: string[];
  audience: string | null;
  source: 'posts' | 'described';
  sourceChannelId: number | null;
  sourcePlatform: string | null;
  postsRead: number;
  status: FirstWeekStatus;
  draftedCount: number;
  weekStartsOn: string | null;
  weekEndsAt: string | null;
  error: string | null;
}

export interface FirstWeekState {
  profile: FirstWeekProfileView | null;
  drafts: FirstWeekDraft[];
  hasChannels: boolean;
  /** The workspace timezone, so the client formats slots without a second request. */
  timezone: string;
  /** When the AI token pool resets (for the no_tokens card); null if unknown. */
  tokensResetAt: string | null;
}
