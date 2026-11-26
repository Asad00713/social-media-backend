/**
 * Meta's long-lived tokens, which are RENEWED rather than refreshed.
 *
 * Facebook, Instagram and Threads all report `supportsRefreshToken: false`,
 * and that is accurate: there is no OAuth2 refresh token to exchange. What
 * they have instead is a 60-day access token that can be handed back to Meta
 * for a fresh 60 days — a different call per platform, with a different
 * `grant_type`, and no `refresh_token` anywhere in it.
 *
 * Nothing called those renewals. `TokenRefreshScheduler` only selects rows
 * `WHERE refresh_token IS NOT NULL`, the just-in-time path in
 * `channel.service.ts` additionally requires `supportsRefreshToken`, and
 * `RefreshTokenExpiryScheduler` needs both `refresh_token` and
 * `refresh_token_issued_at` — so these channels were invisible to all three.
 * The token simply lapsed on day 60: no renewal, and no warning either.
 *
 * Which platforms actually need this, verified against Meta's docs and by
 * probing the live endpoints:
 *
 * - **Instagram** via Instagram Business Login — YES. Stores a 60-day user
 *   token (`channels.controller.ts`, the `exchangeForLongLivedToken` path).
 * - **Threads** — YES. 60-day token; one connect path stores no refresh token
 *   at all and the other stores one that its own API never asks for.
 * - **Facebook** — NO, and this is the part worth stating. Facebook channels
 *   store a PAGE access token (`channel-connect.service.ts` sets
 *   `tokenExpiresAt: undefined` with the comment "Page tokens don't expire"),
 *   and Meta documents long-lived Page tokens as having no expiry. The
 *   Instagram channel created alongside a Page shares that same Page token,
 *   so it does not expire either. Renewing those would be a call with nothing
 *   to renew.
 *
 * So this covers the two platforms that genuinely lapse, and deliberately
 * leaves Facebook alone.
 */

/** Platforms whose access token is renewed by handing it back to Meta. */
export const LONG_LIVED_PLATFORMS = ['instagram', 'threads'] as const;

export type LongLivedPlatform = (typeof LONG_LIVED_PLATFORMS)[number];

export function isLongLivedPlatform(
  platform: string,
): platform is LongLivedPlatform {
  return (LONG_LIVED_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * Renew this far ahead of expiry.
 *
 * Meta gives 60 days and allows a renewal once the token is 24 hours old, so
 * the window is wide. Ten days is chosen to survive a long outage: the daily
 * cron gets ten consecutive chances before access is actually lost, and a
 * token renewed at day 50 still returns a full 60 days, so nothing is wasted
 * by renewing early.
 */
export const RENEW_BEFORE_DAYS = 10;

/** Meta refuses to renew a token younger than this. */
export const MIN_TOKEN_AGE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RenewableChannel {
  platform: string;
  tokenExpiresAt: Date | string | null;
  /** When the row was last written — our best proxy for the token's age. */
  updatedAt?: Date | string | null;
}

/** Why a channel was passed over, for a log line that explains itself. */
export type SkipReason =
  | 'not-long-lived'
  | 'no-expiry'
  | 'not-due'
  | 'too-young'
  | 'already-expired';

export type RenewDecision =
  | { renew: true }
  | { renew: false; reason: SkipReason };

/**
 * Should this channel's token be renewed now?
 *
 * Pure, so the cron's selection rules are testable without a database. The
 * ordering of the checks matters and is asserted: `already-expired` has to be
 * distinguishable from `not-due`, because an expired token cannot be renewed
 * at all and the only remedy is the user reconnecting.
 */
export function shouldRenew(
  channel: RenewableChannel,
  now: Date = new Date(),
): RenewDecision {
  if (!isLongLivedPlatform(channel.platform)) {
    return { renew: false, reason: 'not-long-lived' };
  }

  if (!channel.tokenExpiresAt) {
    // No expiry recorded. For these platforms that means a non-expiring Page
    // token (the Instagram-beside-a-Page case), so there is nothing to renew
    // and nothing wrong.
    return { renew: false, reason: 'no-expiry' };
  }

  const expiresAt = new Date(channel.tokenExpiresAt).getTime();
  if (Number.isNaN(expiresAt)) {
    return { renew: false, reason: 'no-expiry' };
  }

  // Meta rejects a renewal for a token that has already lapsed, so there is
  // no point spending a call on it. The caller marks these for reconnect.
  if (expiresAt <= now.getTime()) {
    return { renew: false, reason: 'already-expired' };
  }

  if (expiresAt - now.getTime() > RENEW_BEFORE_DAYS * DAY_MS) {
    return { renew: false, reason: 'not-due' };
  }

  // "At least 24 hours old" is Meta's rule. `updatedAt` is when we last wrote
  // the row, which is when we last stored a token, so it is the closest thing
  // we have to the token's age. A missing value is treated as old enough
  // rather than blocking the renewal — the alternative is never renewing.
  if (channel.updatedAt) {
    const writtenAt = new Date(channel.updatedAt).getTime();
    if (
      !Number.isNaN(writtenAt) &&
      now.getTime() - writtenAt < MIN_TOKEN_AGE_HOURS * HOUR_MS
    ) {
      return { renew: false, reason: 'too-young' };
    }
  }

  return { renew: true };
}

/** The new expiry to store, given what Meta said the token is good for. */
export function expiryFrom(
  expiresInSeconds: number | null | undefined,
  now: Date = new Date(),
): Date {
  // Meta returns ~5,183,944s (just under 60 days). When it says nothing, 60
  // days is its documented default for every one of these tokens; assuming
  // less would renew needlessly, assuming more would miss the window.
  const seconds =
    typeof expiresInSeconds === 'number' && expiresInSeconds > 0
      ? expiresInSeconds
      : 60 * 24 * 60 * 60;
  return new Date(now.getTime() + seconds * 1000);
}
