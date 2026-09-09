/**
 * Choosing which channels survive a downgrade.
 *
 * When an account's channel ceiling drops below what it has connected, the
 * industry convention is to LOCK the excess, never to disconnect it: Buffer
 * locks and auto-unlocks on upgrade, Metricool keeps the oldest and hides the
 * rest, Later walks the user through a removal flow. Nobody deletes the
 * connection, because the data behind it (history, tokens, scheduled posts) is
 * what the customer fears losing.
 *
 * We follow Metricool's rule — keep the oldest — because it needs no decision
 * from the user at the moment their card fails or their plan lapses, and it is
 * stable: the same set survives however many times it is recomputed.
 */

export interface LockableChannel {
  id: number;
  createdAt: Date;
  isActive: boolean | null;
}

export interface LockPlan {
  /** Channels to leave usable, oldest first. */
  keep: number[];
  /** Channels to lock (set `is_active = false`). */
  lock: number[];
  /** Already-locked channels that fit under the new ceiling again. */
  unlock: number[];
}

/**
 * Decide which channels stay usable under `limit`.
 *
 * Oldest-first by `createdAt`, with `id` as the tie-break so the answer cannot
 * shift between calls when two channels share a timestamp. A negative limit
 * means unlimited — every channel is kept and any locked one is released.
 *
 * The plan is idempotent: feeding it the result of a previous application
 * produces empty `lock`/`unlock` lists.
 */
export function planChannelLocks(
  channels: LockableChannel[],
  limit: number,
): LockPlan {
  const ordered = [...channels].sort((a, b) => {
    const byAge = a.createdAt.getTime() - b.createdAt.getTime();
    return byAge !== 0 ? byAge : a.id - b.id;
  });

  const survivors = limit < 0 ? ordered : ordered.slice(0, Math.max(0, limit));
  const survivorIds = new Set(survivors.map((c) => c.id));

  const plan: LockPlan = { keep: [], lock: [], unlock: [] };

  for (const channel of ordered) {
    const shouldBeActive = survivorIds.has(channel.id);
    const isActive = channel.isActive !== false;

    if (shouldBeActive) {
      plan.keep.push(channel.id);
      if (!isActive) plan.unlock.push(channel.id);
    } else if (isActive) {
      plan.lock.push(channel.id);
    }
  }

  return plan;
}
