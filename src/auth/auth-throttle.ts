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
 * | `2fa/verify` | `TWO_FACTOR_VERIFY_THROTTLE` below, plus 5 wrong codes per challenge and the 10-failure account lock |
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
 * Password-reset mail per visitor.
 *
 * A fan-out cap, not a repeat cap: the 5-minute per-account cooldown in
 * `AuthService` already refuses a second mail to the same address, so this one
 * answers the other question — how many DIFFERENT addresses one caller may mail.
 * Five an hour is generous for the real case (one person recovering one
 * account, perhaps mistyping their address once) and turns "mail a thousand
 * strangers from one host" into a non-event.
 */
export const FORGOT_PASSWORD_THROTTLE = {
  default: { limit: 5, ttl: ONE_HOUR_MS },
} as const;

/**
 * Verification-code resends per visitor. Deliberately looser than the reset
 * limit above, and for a user-experience reason rather than a security one.
 *
 * Resend is the one button a half-finished signup has. The real path through it
 * is not one press: the first code lands in spam, so they press it; it is still
 * not there, so they press again; then they spot the typo in their address,
 * take "Use a different email", sign up again, and need codes for the new
 * address too. Five an hour runs out partway through that, and the screen it
 * runs out on has nowhere else to go — the person is locked out of their own
 * signup for the rest of the hour.
 *
 * Fifteen in fifteen minutes is the shape `admin/challenge` arrived at after
 * exactly this failure (its comment records a limit of 5 that a couple of
 * fumbled sign-ins burned through). The shorter window matters more than the
 * bigger number: whatever a person does wrong, they are never more than fifteen
 * minutes from trying again.
 *
 * It is still a real cap on mail. The per-account cooldown is 60s, so a single
 * address cannot take more than 15 of these anyway, and fan-out is bounded at
 * 60 an hour from one caller — against an endpoint that only ever mails an
 * address that already has an unverified account waiting on it.
 */
export const RESEND_CODE_THROTTLE = {
  default: { limit: 15, ttl: FIFTEEN_MIN_MS },
} as const;

/**
 * Second-factor guesses per visitor (`POST /auth/2fa/verify`).
 *
 * The real limits are in the database: five wrong codes burn a challenge and
 * ten consecutive failures lock the account for 15 minutes, both atomic, so
 * they hold across instances. This per-IP ceiling is the cheap outer fence
 * that keeps one caller from cycling fresh challenges (each needs the
 * password, which `login` already throttles) or flooding the verify step.
 * Ten in fifteen minutes matches `login`: a person typing a six-digit code
 * needs two or three tries, never ten.
 */
export const TWO_FACTOR_VERIFY_THROTTLE = {
  default: { limit: 10, ttl: FIFTEEN_MIN_MS },
} as const;
