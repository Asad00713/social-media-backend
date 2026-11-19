/**
 * Which DM conversations are worth fetching this cycle.
 *
 * ## The bug this closes
 *
 * The DM poller fetched every listed conversation on every cycle. For
 * Instagram that is TWO calls per conversation (a thread-id lookup, then the
 * messages edge), every 30 seconds, forever — whether or not anything had
 * changed.
 *
 * Measured on production: ONE conversation produced **2,115 rows** in
 * `error_logs` in seven days, all of them
 * `403 {"message":"Application request limit reached"}`. The top three
 * conversations on one channel accounted for ~4,500. The loop fed the very
 * rate limit it was dying on: poll -> 403 -> log -> poll again 30s later.
 *
 * ## Why `since` could not simply be passed through
 *
 * Both IG methods already accepted a `since` and ignored it (`_since`). That
 * was not laziness: Meta does not offer a server-side time filter here.
 * `Page Conversations` states time-based pagination is not available, and for
 * Instagram the messages edge serves only *"the 20 most recent messages in
 * the conversation"* regardless of the `limit` asked for.
 *
 * So the saving has to come from not making the call at all. The conversation
 * list already carries `lastMessageAt`, so a conversation with nothing newer
 * than the last poll has nothing to fetch.
 *
 * ## Why this still sweeps
 *
 * Skipping purely on `lastMessageAt <= since` would mean trusting the
 * platform to always move that timestamp. If it ever did not, a real customer
 * message would sit unread until something else bumped the conversation —
 * an inbox that silently loses a message is far worse than a wasted API call,
 * which is the whole failure this fix exists to avoid repeating.
 *
 * So an unchanged conversation is still swept once per `SWEEP_INTERVAL_MS`.
 * The common case costs nothing; the uncommon case is bounded and self-heals.
 */

/** How long an unchanged conversation may go unfetched before a safety sweep. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface DmPollCandidate {
  conversationId: string;
  lastMessageAt: Date;
}

export interface DmPollDecision<T extends DmPollCandidate> {
  /** Conversations to fetch this cycle, in the caller's own type. */
  fetch: T[];
  /** Conversations skipped because nothing is new and a sweep is not due. */
  skipped: number;
}

/**
 * Decide which conversations to fetch.
 *
 * @param conversations the platform's conversation list for this channel
 * @param since         the channel's previous poll time, or null/undefined on
 *                      a first poll (then everything is fetched)
 * @param lastSweptAt   when this channel last swept every conversation
 * @param now           injected for testability
 */
export function selectDmConversationsToFetch<T extends DmPollCandidate>(
  conversations: readonly T[],
  since: Date | null | undefined,
  lastSweptAt: Date | null | undefined,
  now: Date = new Date(),
): DmPollDecision<T> {
  // A channel that has never been polled has no cursor to trust: fetch all.
  if (!since) return { fetch: [...conversations], skipped: 0 };

  // Periodic safety sweep: fetch everything, however quiet it looks.
  const sweepDue =
    !lastSweptAt || now.getTime() - lastSweptAt.getTime() >= SWEEP_INTERVAL_MS;
  if (sweepDue) return { fetch: [...conversations], skipped: 0 };

  const fetch: T[] = [];
  let skipped = 0;
  for (const convo of conversations) {
    // `>` not `>=`: a conversation whose last message landed exactly on the
    // cursor was already ingested by the poll that set it.
    if (convo.lastMessageAt.getTime() > since.getTime()) fetch.push(convo);
    else skipped += 1;
  }
  return { fetch, skipped };
}
