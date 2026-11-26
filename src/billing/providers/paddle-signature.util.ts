import * as crypto from 'crypto';

/**
 * Verifying a Paddle webhook's `Paddle-Signature` header.
 *
 * Its own pure module, unlike Lemon Squeezy's one-liner inside the webhook
 * service, because Paddle's header has structure and three of its details are
 * each a way to get this silently wrong:
 *
 * 1. The signed string is `${ts}:${rawBody}`, NOT the body alone. Signing the
 *    body would reject every real webhook, which looks like a bad secret.
 * 2. `h1` can appear MORE THAN ONCE while a secret is being rotated. Taking
 *    the first and ignoring the rest drops live traffic for the length of the
 *    rotation — the one window the repetition exists to cover.
 * 3. The timestamp bounds a replay. Paddle's own SDK rejects events older
 *    than five seconds; that is far too tight for a service that may be
 *    mid-deploy or behind a cold start, so this uses a wider window and says
 *    why below.
 */

export const PADDLE_WEBHOOK_SECRET_ENV = 'PADDLE_WEBHOOK_SECRET';

/**
 * How old a signature may be.
 *
 * Paddle's example code uses 5 seconds. That is a sensible default for a
 * warm server and a bad one here: Railway cold starts, a deploy rolling over
 * and Paddle's own retry schedule all put legitimate deliveries past it, and
 * a webhook rejected for age is a subscription whose state never lands. Five
 * minutes still makes a captured signature useless long before anyone could
 * use it, and matches what Stripe's library defaults to.
 */
export const PADDLE_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export interface PaddleSignatureParts {
  /** Unix seconds, as sent. */
  ts: string;
  /** Every `h1` in the header, in order. More than one during rotation. */
  h1: string[];
}

/**
 * Split `ts=1671552777;h1=eb4d...` into its parts.
 *
 * Returns null for anything that does not carry both, so a caller cannot
 * accidentally verify against an empty list — which would compare nothing and
 * could be mistaken for success.
 */
export function parsePaddleSignature(
  header: string | undefined | null,
): PaddleSignatureParts | null {
  if (!header) return null;

  let ts: string | null = null;
  const h1: string[] = [];

  for (const element of header.split(';')) {
    const at = element.indexOf('=');
    if (at <= 0) continue;
    const key = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (!value) continue;
    if (key === 'ts') ts = value;
    else if (key === 'h1') h1.push(value);
  }

  if (!ts || h1.length === 0) return null;
  return { ts, h1 };
}

/** The exact string Paddle signs: the timestamp, a colon, then the raw body. */
export function paddleSignedPayload(ts: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), rawBody]);
}

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, for the log. Never shown to a caller over HTTP. */
  reason?: 'no-secret' | 'malformed' | 'stale' | 'mismatch';
}

/**
 * Whether this body really came from Paddle.
 *
 * Fails CLOSED on every uncertainty, including a missing secret: an
 * unverified billing webhook can cancel a subscription or mark an account
 * paid, so trusting one because the server is misconfigured is worse than
 * dropping it and retrying.
 *
 * `rawBody` must be the bytes as received. Re-serialised JSON will not match,
 * even when it parses to the same object — key order and whitespace are part
 * of what was signed.
 */
export function verifyPaddleSignature(
  rawBody: Buffer,
  header: string | undefined | null,
  secret: string | undefined | null,
  now: Date = new Date(),
): VerifyResult {
  if (!secret) return { ok: false, reason: 'no-secret' };

  const parts = parsePaddleSignature(header);
  if (!parts) return { ok: false, reason: 'malformed' };

  const tsSeconds = Number(parts.ts);
  if (!Number.isFinite(tsSeconds)) return { ok: false, reason: 'malformed' };

  // Absolute difference, so a clock that is ahead is caught too. A future
  // timestamp is as much a sign of a forged header as an old one.
  const ageMs = Math.abs(now.getTime() - tsSeconds * 1000);
  if (ageMs > PADDLE_SIGNATURE_MAX_AGE_MS) return { ok: false, reason: 'stale' };

  const expected = crypto
    .createHmac('sha256', secret)
    .update(paddleSignedPayload(parts.ts, rawBody))
    .digest();

  // EVERY h1 is tried. During a secret rotation Paddle signs with both the
  // old and the new secret and sends both hashes; a verifier that only read
  // the first would reject half the traffic for the whole rotation window.
  for (const candidate of parts.h1) {
    let received: Buffer;
    try {
      received = Buffer.from(candidate, 'hex');
    } catch {
      continue;
    }
    // `timingSafeEqual` THROWS on a length mismatch rather than returning
    // false, so the lengths are compared first.
    if (received.length !== expected.length) continue;
    if (crypto.timingSafeEqual(expected, received)) return { ok: true };
  }

  return { ok: false, reason: 'mismatch' };
}
