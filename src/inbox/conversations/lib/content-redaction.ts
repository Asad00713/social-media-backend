import type { InboxItem } from '../../../drizzle/schema/inbox.schema';

/**
 * True when a row's text was wiped by the YouTube retention job
 * (YouTube Developer Policy III.E.4.c) rather than genuinely empty.
 *
 * MUST be computed from the raw DB value BEFORE any `?? ''` coalescing, and
 * never with a falsy check: a genuinely empty string is not redacted.
 *
 * Pure copy of `isContentRedacted` in `inbox.service.ts` so the conversation
 * libs do not import the service graph. Foundation turns that copy into a
 * re-export of this one; `content-redaction.spec.ts` keeps the two in
 * agreement until then.
 */
export function isContentRedacted(
  item: Pick<InboxItem, 'platform' | 'text'>,
): boolean {
  return item.platform === 'youtube' && item.text === null;
}
