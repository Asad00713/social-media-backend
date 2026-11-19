/**
 * The platform says this media has no comments edge, and never will.
 *
 * Meta answers `(#100) nonexisting field (comments)` — or `(#803) Some of the
 * aliases you requested do not exist` — for a Story, a deleted post, or a
 * media whose edge is not named `comments`. Both the Facebook and Instagram
 * pollers already recognised that and returned no comments rather than failing
 * the poll, which was correct as far as it went.
 *
 * It did not go far enough, because "no comments" and "no comments edge" are
 * indistinguishable to the caller, and only one of them is worth asking about
 * again. One Instagram Story was therefore asked **20,169 times in seven
 * days** — every 30 seconds, forever.
 *
 * Throwing this instead of returning an empty array makes the difference
 * visible exactly once, at the only two call sites that exist (the inbox
 * adapters), which record it and stop asking. Every other failure keeps its
 * current behaviour.
 */
export class NonCommentableMediaError extends Error {
  readonly platformPostId: string;
  /** The platform error that produced it, stored on the row for later. */
  readonly reason: string;

  constructor(platformPostId: string, reason: string) {
    super(`Media ${platformPostId} has no comments edge (${reason})`);
    this.name = 'NonCommentableMediaError';
    this.platformPostId = platformPostId;
    this.reason = reason;
  }
}

/**
 * Which Meta error means "this edge does not exist", as opposed to a transient
 * failure or a permissions problem.
 *
 * Both checks were already inline in the two services, with the same comments;
 * this is them, unchanged, in one place so the two cannot drift.
 *
 *  - **(#100) "nonexisting field (comments)"** — the id is a media whose edge
 *    is not called `comments` (a Story), or the media is gone.
 *  - **(#803) "Some of the aliases you requested do not exist"** — the same
 *    class of error reached by a different code path.
 */
export function nonCommentableReason(
  status: number,
  errorText: string,
): string | null {
  if (status !== 400) return null;
  if (/code"\s*:\s*100/.test(errorText) || /nonexisting field/i.test(errorText))
    return 'no_comments_edge';
  if (/aliases you requested do not exist/i.test(errorText))
    return 'alias_not_found';
  return null;
}
