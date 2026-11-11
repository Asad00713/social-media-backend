/**
 * What a chain-capable platform (X, Threads, Bluesky, Mastodon) publishes,
 * decided by the format the composer picked for it.
 *
 * The composer stores the format as `platformSpecific.postType` — `post`,
 * `thread` or `poll` (Bluesky: `post` or `thread`). Switching format does NOT
 * clear the other formats' fields: a Post that was a Thread a minute ago
 * still carries `thread`, and one that was a Poll still carries `poll`. The
 * publishers used to decide from the shape of what was stored
 * (`thread.length > 1`, `poll` present), so a post switched back to Post
 * published the stale thread or poll instead of what was on screen.
 *
 * Here the format decides. A row with no `postType` at all (saved before the
 * format existed, or written by an API client that never sent one) keeps the
 * old shape-based behaviour, so nothing that published before stops
 * publishing.
 */

/** The composer's slug for a reply chain. */
export const THREAD_POST_TYPE = 'thread';

/** The composer's slug for a poll. */
export const POLL_POST_TYPE = 'poll';

/** The format the composer picked, or undefined when none was stored. */
export function postTypeOf(
  metadata: Record<string, any> | undefined,
): string | undefined {
  const raw: unknown = metadata?.postType;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * The thread to publish as a reply chain, or undefined for a single post.
 *
 * Only when the format is Thread (or no format was stored), and only when it
 * has more than one post — a thread of one is a single post.
 */
export function threadToPublish<T = unknown>(
  metadata: Record<string, any> | undefined,
): T[] | undefined {
  const thread: unknown = metadata?.thread;
  if (!Array.isArray(thread) || thread.length <= 1) return undefined;
  const postType = postTypeOf(metadata);
  if (postType !== undefined && postType !== THREAD_POST_TYPE) {
    return undefined;
  }
  return thread as T[];
}

/**
 * Whether a stored poll may be published: only when the format is Poll (or
 * no format was stored). A poll left over from before a switch to Post or
 * Thread is never sent.
 */
export function isPollAllowed(
  metadata: Record<string, any> | undefined,
): boolean {
  const postType = postTypeOf(metadata);
  return postType === undefined || postType === POLL_POST_TYPE;
}

/** Whether the composer explicitly picked the Poll format. */
export function isPollFormat(
  metadata: Record<string, any> | undefined,
): boolean {
  return postTypeOf(metadata) === POLL_POST_TYPE;
}
