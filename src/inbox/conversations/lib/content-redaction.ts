import type { InboxItem } from '../../../drizzle/schema/inbox.schema';

/**
 * True when a row's text was wiped by the YouTube retention job
 * (YouTube Developer Policy III.E.4.c) rather than genuinely empty.
 *
 * MUST be computed from the raw DB value BEFORE any `?? ''` coalescing, and
 * never with a falsy check: a genuinely empty string is not redacted.
 *
 * The single implementation: `inbox.service.ts` re-exports it, so the
 * conversation libs do not import the service graph.
 */
export function isContentRedacted(
  item: Pick<InboxItem, 'platform' | 'text'>,
): boolean {
  return item.platform === 'youtube' && item.text === null;
}
