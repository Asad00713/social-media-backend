import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { SessionStore } from './session-store';

/** A revoke on another instance takes effect within this (spec §7.1). */
export const SESSION_CHECK_TTL_MS = 30_000;
/** Bound on cached sids per process; the oldest entry goes first. */
export const SESSION_CHECK_MAX = 10_000;

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
 * revoke, so on the instance that revoked the answer flips at once.
 *
 * Per process and in memory on purpose: a shared cache would need Redis on
 * the auth path, and 30 s is the delay the spec accepts.
 */
@Injectable()
export class SessionCheck {
  private readonly cache = new Map<string, Entry>();

  constructor(
    @Inject(forwardRef(() => SessionStore))
    private readonly store: SessionStore,
  ) {}

  async isLive(sid: string, userId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(sid);
    if (hit && hit.userId === userId && hit.expiresAt > now) return hit.live;

    const live = await this.store.isLive(sid, userId);
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
  }

  /** Entries held (for tests and diagnostics). */
  get size(): number {
    return this.cache.size;
  }
}
