/**
 * Per-IP ceilings for the unauthenticated auth routes.
 *
 * ## What was already protected, and is therefore NOT here
 *
 * The audit listed every unthrottled route on this controller. Most of them
 * did not need a throttle, because something stronger already stood in the
 * way. Checked one by one:
 *
 * | Route | Already bounded by |
 * |---|---|
 * | `verify-otp` | `MAX_CODE_ATTEMPTS` (5), claimed ATOMICALLY before the comparison — a parallel burst cannot test a sixth code |
 * | `reset-password` | a `crypto.randomBytes(32)` token: 256 bits, not guessable |
 * | `verify-email` | the same token shape |
 * | `refresh` / `logout` / `me` / `onboarding` | a JWT guard |
 * | `admin/challenge` / `admin/verify` | their own `@Throttle`, plus a per-address cooldown |
 *
 * Adding a limit to any of those would be decoration: it would pass its tests
 * and protect nothing, which is the mistake BE #247 made with a sweeper guard
 * for a state that could not occur.
 *
 * ## What is genuinely open
 *
 * `login` has no attempt counter, no lockout and no throttle, and `bcrypt` at
 * cost 10 spends real CPU on every guess — so an unbounded `login` is both a
 * credential-stuffing surface and a cheap way to saturate the web process.
 *
 * `register` checks only for a duplicate address, so a script can mint
 * accounts at will and each one sends a verification email.
 *
 * `forgot-password` and `resend-verification` DO carry a cooldown, but it is
 * keyed on the ACCOUNT (5 minutes and 60 seconds respectively). That stops a
 * single address being mailed repeatedly; it does nothing about fan-out,
 * because a thousand different addresses each get their first email for free.
 * The limits below cap the fan-out per caller; the per-account cooldowns stay
 * exactly as they are, since the two answer different questions.
 */

/** Fifteen minutes, the window `admin/verify` already uses. */
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Sign-in attempts per visitor.
 *
 * Ten in fifteen minutes is the ceiling `admin/verify` was tuned to, and the
 * reasoning carries over: a person who has mistyped a password ten times in a
 * quarter of an hour is going to use the reset link, not an eleventh guess. It
 * leaves credential stuffing nowhere to go — a list of any useful length needs
 * orders of magnitude more than forty attempts an hour.
 */
export const LOGIN_THROTTLE = {
  default: { limit: 10, ttl: FIFTEEN_MIN_MS },
} as const;

/**
 * Signups per visitor.
 *
 * Someone signs up once. Five an hour covers a typo in the address, a
 * forgotten password mid-signup, and a shared office NAT where two or three
 * colleagues register the same afternoon — while refusing a script that wants
 * ten thousand accounts and ten thousand verification emails.
 */
export const REGISTER_THROTTLE = {
  default: { limit: 5, ttl: ONE_HOUR_MS },
} as const;

/**
 * Account-recovery and resend mail per visitor.
 *
 * This is a fan-out cap, not a repeat cap: the per-account cooldowns in
 * `AuthService` already refuse a second mail to the same address. Five an hour
 * is generous for the real case (one person recovering one account, perhaps
 * mistyping their address once or twice) and turns "mail a thousand strangers
 * from one host" into a non-event.
 */
export const RECOVERY_MAIL_THROTTLE = {
  default: { limit: 5, ttl: ONE_HOUR_MS },
} as const;
