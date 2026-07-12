import { createHash } from 'crypto';
import {
  SCHEDURA_POST_ID_PROP,
  SCHEDURA_WORKSPACE_ID_PROP,
} from './calendar-sync.constants';

// Default calendar-event duration when a post has no explicit end time.
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Max length of the event title derived from post content.
const MAX_SUMMARY_LENGTH = 80;

// Shown when a scheduled post has no caption/content.
const EMPTY_SUMMARY_FALLBACK = '(untitled post)';

// Minimal post shape the mapper needs. Kept structural (not the full Drizzle
// row) so it is trivial to unit-test and decoupled from schema churn.
export interface PostForMapping {
  id: string;
  workspaceId: string;
  content: string | null;
  scheduledAt: Date | null;
}

// Provider-agnostic event body the push service hands to
// GoogleCalendarService/OutlookCalendarService.createEvent/updateEvent.
export interface EventInput {
  summary: string;
  startTime: Date;
  endTime: Date;
  privateProps: Record<string, string>;
}

/**
 * Derive a concise, single-line event title from post content.
 */
function toSummary(content: string | null): string {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return EMPTY_SUMMARY_FALLBACK;
  }
  if (collapsed.length <= MAX_SUMMARY_LENGTH) {
    return collapsed;
  }
  // Reserve one char for the ellipsis.
  return collapsed.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd() + '…';
}

/**
 * Map a scheduled post to the provider-agnostic event body, tagged with the
 * ownership private props (`schedura_post_id` + `schedura_workspace_id`) so
 * two-way write-back only ever touches events we created.
 *
 * Throws if the post has no `scheduledAt` — callers must gate on schedulability.
 */
export function postToEventInput(post: PostForMapping): EventInput {
  if (!post.scheduledAt) {
    throw new Error(
      `Cannot map post ${post.id} to a calendar event: missing scheduledAt`,
    );
  }
  const startTime = new Date(post.scheduledAt);
  const endTime = new Date(startTime.getTime() + DEFAULT_EVENT_DURATION_MS);

  return {
    summary: toSummary(post.content),
    startTime,
    endTime,
    privateProps: {
      [SCHEDURA_POST_ID_PROP]: post.id,
      [SCHEDURA_WORKSPACE_ID_PROP]: post.workspaceId,
    },
  };
}

/**
 * Stable, short content hash of the mutable event fields we push
 * ({summary,start,end}). Stored on the link as `lastPushedHash` and used for
 * echo suppression + skip-unchanged optimisation. Deterministic across runs.
 */
export function contentHash(input: {
  summary: string;
  startTime: Date;
  endTime: Date;
}): string {
  const canonical = [
    input.summary,
    new Date(input.startTime).toISOString(),
    new Date(input.endTime).toISOString(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
