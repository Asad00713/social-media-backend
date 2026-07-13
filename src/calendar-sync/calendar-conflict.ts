import { contentHash } from './calendar-sync.mapper';

// =============================================================================
// Calendar conflict engine (PURE)
// -----------------------------------------------------------------------------
// Decides what to do with an inbound change to an event WE wrote (an event
// carrying our `schedura_post_id` / `schedura_message_id` tag and backed by a
// `calendar_item_links` row).
//
// The item is a scheduled POST or a scheduled INBOX MESSAGE; the truth table is
// identical for both, so the engine only ever sees the two fields they share
// (`updatedAt` + `scheduledAt`). The CALLER applies the decision and knows which
// kind it holds (post -> draft, message -> cancelled).
//
// Last-write-wins by updated timestamp, guarded by etag + content-hash echo
// suppression so our OWN writes coming back down the delta stream can never
// bounce back up again (ping-pong):
//
//   1. the event was deleted externally        -> apply_external (post -> draft /
//                                                 message -> cancelled)
//   2. the event's etag is the one we stored   -> skip_echo   (this IS our write)
//   3. the event's content is what we pushed   -> skip_echo   (etag drifted, same content)
//   4. the external edit is newer than the post-> apply_external (reschedule post)
//   5. otherwise                               -> repush_app  (app wins, rewrite event)
//
// Dependency-free (no Nest, no DB) so the whole truth table is unit-testable.
// =============================================================================

export type ConflictDecision =
  | 'skip_echo'
  | 'apply_external'
  | 'repush_app'
  | 'noop';

/** The `calendar_item_links` fields the decision depends on. */
export interface ConflictLink {
  /** Provider etag/changeKey of the version WE last wrote. */
  etag?: string | null;
  /** `contentHash()` of the event body WE last wrote. */
  lastPushedHash?: string | null;
}

/**
 * The inbound provider event, normalized. `NormalizedExternalEvent` satisfies
 * this shape structurally; a tombstone is `{ deleted: true }`.
 */
export interface ConflictEvent {
  /** True when the provider reported the event as removed/cancelled. */
  deleted?: boolean;
  etag?: string | null;
  title?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** Provider last-modified (Google `updated`, Graph `lastModifiedDateTime`). */
  externalUpdatedAt?: Date | null;
}

/**
 * The app-side item fields the decision depends on. Named `ConflictPost` for
 * historical reasons — a scheduled inbox message satisfies it structurally and
 * is resolved through exactly the same truth table.
 */
export interface ConflictPost {
  updatedAt?: Date | null;
  scheduledAt?: Date | null;
}

export interface ResolveConflictArgs {
  link: ConflictLink;
  event: ConflictEvent;
  post: ConflictPost;
}

/**
 * Hash the INBOUND event with the same canonical form the push side uses for
 * `lastPushedHash` ({summary,start,end}). Returns null when the event carries no
 * usable time range (nothing comparable to hash).
 */
export function eventContentHash(event: ConflictEvent): string | null {
  if (!event.startsAt || !event.endsAt) return null;
  return contentHash({
    summary: event.title ?? '',
    startTime: event.startsAt,
    endTime: event.endsAt,
  });
}

/**
 * Resolve one inbound change to an event we own. Pure: no I/O, no side effects.
 * The caller applies the decision (see `CalendarPullSyncService`).
 */
export function resolveConflict({
  link,
  event,
  post,
}: ResolveConflictArgs): ConflictDecision {
  // 1. External delete always wins — the post goes back to draft (NEVER deleted).
  if (event.deleted) {
    return 'apply_external';
  }

  // 2. Echo by etag: the provider is handing us back the exact version we wrote.
  if (link.etag && event.etag && event.etag === link.etag) {
    return 'skip_echo';
  }

  // 3. Echo by content: the etag drifted (re-write, provider quirk) but the body
  //    is byte-for-byte what we last pushed → still our own change.
  const hash = eventContentHash(event);
  if (link.lastPushedHash && hash && hash === link.lastPushedHash) {
    return 'skip_echo';
  }

  // 4. Last-write-wins: the user's calendar edit is newer than the post.
  if (isExternalNewer(event.externalUpdatedAt, post.updatedAt)) {
    // Nothing to apply when the event carries no start, or already sits exactly
    // where the post is scheduled (e.g. a title/description-only edit — those
    // never change post content).
    if (!event.startsAt || isSameInstant(event.startsAt, post.scheduledAt)) {
      return 'noop';
    }
    return 'apply_external';
  }

  // 5. The app is the newer writer (or the provider gave us no timestamp to
  //    compare) → the post is the source of truth; rewrite the event from it.
  return 'repush_app';
}

/**
 * Is the provider's last-modified strictly newer than the post's?
 * - No external timestamp → we cannot claim the external side is newer (the app
 *   wins, which converges: `repush_app` rewrites the event and stamps the link).
 * - No post timestamp (shouldn't happen; `posts.updated_at` is NOT NULL) → the
 *   external side wins.
 */
function isExternalNewer(
  externalUpdatedAt?: Date | null,
  postUpdatedAt?: Date | null,
): boolean {
  if (!externalUpdatedAt) return false;
  if (!postUpdatedAt) return true;
  return externalUpdatedAt.getTime() > postUpdatedAt.getTime();
}

function isSameInstant(a?: Date | null, b?: Date | null): boolean {
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
}
