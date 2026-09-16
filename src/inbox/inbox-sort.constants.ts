/**
 * Result orderings for the inbox listings.
 *
 * In their own module rather than beside either consumer, because both need
 * them at runtime and each would otherwise drag the other in:
 *
 * - `inbox-search.helpers` is deliberately free of Nest and class-validator so
 *   its pure functions can be unit-tested without `reflect-metadata`. Importing
 *   the DTO for these constants pulled the decorators in and broke that.
 * - `list-comments.dto` cannot import the helpers either, since the helpers
 *   already import `InboxFolder` from it.
 */
export const INBOX_SORTS = ['newest', 'oldest', 'unanswered'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const DEFAULT_INBOX_SORT: InboxSort = 'newest';
