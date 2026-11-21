import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { SessionStore } from './session-store';

/** A revoke on another instance takes effect within this (spec §7.1). */
export const SESSION_CHECK_TTL_MS = 30_000;
/** Bound on cached sids per process; the oldest entry goes first. */
export const SESSION_CHECK_MAX = 10_000;
/**
 * After `forget`, a `true` for that sid is not cached for this long: a read
 * that was in flight when the revoke ran, or one made between the revoke and
 * its transaction's COMMIT, may still see the row live, and caching it would
 * hold a revoked session open for 30 s on the very instance that revoked it.
 * Twice the TTL covers a slow commit.
 */
export const SESSION_CHECK_TOMBSTONE_MS = 2 * SESSION_CHECK_TTL_MS;

interface Entry {
  userId: string;
  live: boolean;
  expiresAt: number;
}

/**
 * "Is this sid still a live session?" for every authenticated request,
 * cached 30 s per sid so the access path does not read the database on each
 * call. Both answers are cached: a revoked token hammering the API costs one
 * read per 30 s, not one per request. `SessionStore` calls `forget` on every
 * revoke, so on the instance that revoked the answer flips at once: the
 * entry goes and the sid is tombstoned, so no stale `true` (a read racing the
 * revoke, or one before the revoking transaction commits) is cached again.
 * Callers that revoke inside a transaction therefore need no post-commit
 * step.
 *
 * Per process and in memory on purpose: a shared cache would need Redis on
 * the auth path, and 30 s is the delay the spec accepts.
 */
@Injectable()
export class SessionCheck {
  private readonly cache = new Map<string, Entry>();
  /** sid -> until when a `true` for it is not cached. */
  private readonly tombstones = new Map<string, number>();

  constructor(
    @Inject(forwardRef(() => SessionStore))
    private readonly store: SessionStore,
  ) {}

  async isLive(sid: string, userId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(sid);
    if (hit && hit.userId === userId && hit.expiresAt > now) return hit.live;

    const live = await this.store.isLive(sid, userId);
    if (live && (this.tombstones.get(sid) ?? 0) > Date.now()) {
      // Revoked while this read was in flight, or not yet committed: answer
      // it, never cache it.
      return live;
    }
    // Re-insert so Map order is "oldest written first" for eviction.
    this.cache.delete(sid);
    this.cache.set(sid, {
      userId,
      live,
      expiresAt: now + SESSION_CHECK_TTL_MS,
    });
    while (this.cache.size > SESSION_CHECK_MAX) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return live;
  }

  forget(sid: string): void {
    this.cache.delete(sid);
    const now = Date.now();
    this.tombstones.delete(sid);
    this.tombstones.set(sid, now + SESSION_CHECK_TOMBSTONE_MS);
    // Insertion order is oldest first; bounded like the cache.
    while (this.tombstones.size > SESSION_CHECK_MAX) {
      this.tombstones.delete(this.tombstones.keys().next().value as string);
    }
  }

  /** Entries held (for tests and diagnostics). */
  get size(): number {
    return this.cache.size;
  }
}
