import { createHash } from 'crypto';
import {
  SCHEDURA_MESSAGE_ID_PROP,
  SCHEDURA_POST_ID_PROP,
  SCHEDURA_WORKSPACE_ID_PROP,
} from './calendar-sync.constants';

// Default calendar-event duration when an item has no explicit end time.
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Max length of the event title derived from item content.
const MAX_SUMMARY_LENGTH = 80;

// Shown when a scheduled post has no caption/content.
const EMPTY_SUMMARY_FALLBACK = '(untitled post)';

// Shown when a scheduled message carries neither a target label nor text.
const EMPTY_MESSAGE_SUMMARY_FALLBACK = 'Scheduled reply';

// Minimal post shape the mapper needs. Kept structural (not the full Drizzle
// row) so it is trivial to unit-test and decoupled from schema churn.
export interface PostForMapping {
  id: string;
  workspaceId: string;
  content: string | null;
  scheduledAt: Date | null;
  // Used for the event title when `content` is empty. Title-only platforms
  // (YouTube, Pinterest) keep their real title in platformContent, not in the
  // shared caption — without this such posts show up as "(untitled post)".
  fallbackTitle?: string | null;
}

// Minimal scheduled-inbox-message shape the mapper needs. Same rationale as
// PostForMapping — structural, not the Drizzle row.
export interface MessageForMapping {
  id: string;
  workspaceId: string;
  /** Reply/DM body. May contain light HTML (the composer is rich-text). */
  text: string | null;
  /** Human-readable target, e.g. `@alex` or `Post · @bob`. */
  targetLabel: string | null;
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

/** Collapse whitespace to a single line. */
function collapse(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Strip the composer's light HTML so the calendar title is plain text. */
function stripHtml(value: string | null | undefined): string {
  return collapse(
    (value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'),
  );
}

/** Clamp a single-line title to MAX_SUMMARY_LENGTH with an ellipsis. */
function truncate(collapsed: string): string {
  if (collapsed.length <= MAX_SUMMARY_LENGTH) {
    return collapsed;
  }
  // Reserve one char for the ellipsis.
  return collapsed.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd() + '…';
}

/**
 * Derive a concise, single-line event title. Prefers the post's caption, then
 * falls back to a platform/draft title (for title-only posts like YouTube whose
 * caption is empty), then to a generic placeholder.
 */
function toSummary(
  content: string | null,
  fallbackTitle?: string | null,
): string {
  const collapsed = collapse(content);
  const source = collapsed.length > 0 ? collapsed : collapse(fallbackTitle);
  if (source.length === 0) {
    return EMPTY_SUMMARY_FALLBACK;
  }
  return truncate(source);
}

/**
 * Derive a concise, single-line event title for a scheduled inbox message.
 * Reads like a calendar entry rather than a raw body dump:
 *
 *   label + text  ->  `Reply to @alex: thanks for the kind words!`
 *   label only    ->  `Reply to @alex`
 *   text only     ->  `Reply: thanks for the kind words!`
 *   neither       ->  `Scheduled reply`
 */
function toMessageSummary(
  targetLabel: string | null,
  text: string | null,
): string {
  const label = collapse(targetLabel);
  const excerpt = stripHtml(text);

  if (label && excerpt) return truncate(`Reply to ${label}: ${excerpt}`);
  if (label) return truncate(`Reply to ${label}`);
  if (excerpt) return truncate(`Reply: ${excerpt}`);
  return EMPTY_MESSAGE_SUMMARY_FALLBACK;
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
    summary: toSummary(post.content, post.fallbackTitle),
    startTime,
    endTime,
    privateProps: {
      [SCHEDURA_POST_ID_PROP]: post.id,
      [SCHEDURA_WORKSPACE_ID_PROP]: post.workspaceId,
    },
  };
}

/**
 * Map a scheduled inbox message (comment reply / DM) to the provider-agnostic
 * event body, tagged with `schedura_message_id` + `schedura_workspace_id`.
 *
 * Deliberately a SEPARATE tag from `schedura_post_id`: post events already live
 * in real calendars keyed by that prop, and re-keying them would orphan them.
 *
 * Throws if the message has no `scheduledAt` — callers must gate on
 * schedulability (status === 'pending').
 */
export function messageToEventInput(message: MessageForMapping): EventInput {
  if (!message.scheduledAt) {
    throw new Error(
      `Cannot map scheduled message ${message.id} to a calendar event: missing scheduledAt`,
    );
  }
  const startTime = new Date(message.scheduledAt);
  const endTime = new Date(startTime.getTime() + DEFAULT_EVENT_DURATION_MS);

  return {
    summary: toMessageSummary(message.targetLabel, message.text),
    startTime,
    endTime,
    privateProps: {
      [SCHEDURA_MESSAGE_ID_PROP]: message.id,
      [SCHEDURA_WORKSPACE_ID_PROP]: message.workspaceId,
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
