import { randomBytes } from 'crypto';
import { Secret, TOTP } from 'otpauth';

/**
 * TOTP primitives for two-step sign-in (spec §7.2).
 *
 * RFC 6238 with the parameters every authenticator app defaults to: SHA-1,
 * 6 digits, 30 s period. A code from the step before or after the current one
 * is accepted (window +/-1) to absorb clock drift. The library does the HMAC
 * and the window search; this file only pins the parameters and reports WHICH
 * step matched, because the replay guard (SecondFactorService) stores the
 * last accepted step and refuses anything at or below it.
 */

export const TOTP_ISSUER = 'Schedura';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;

const SECRET_BYTES = 20; // 160 bits, the RFC 4226 recommended length
const CODE_SHAPE = /^\d{6}$/;
const PERIOD_MS = TOTP_PERIOD_SECONDS * 1000;

function totpFor(secretB32: string, accountEmail = 'account'): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: accountEmail,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secretB32),
  });
}

/** A fresh 160-bit secret as unpadded base32 (32 chars). */
export function newTotpSecret(): string {
  const bytes = new Uint8Array(randomBytes(SECRET_BYTES));
  return new Secret({ buffer: bytes.buffer }).base32;
}

/** The `otpauth://totp/...` URI an authenticator app scans as a QR code. */
export function totpUrl(secretB32: string, accountEmail: string): string {
  return totpFor(secretB32, accountEmail).toString();
}

/** "ABCD EFGH IJ…" — the key as a person types it by hand. */
export function groupSecret(secretB32: string): string {
  return (secretB32.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Returns the time step the code belongs to (`floor(now / 30 s) + delta`) or
 * `null` when it matches no step in the window. Anything that is not exactly
 * six digits is refused before the library sees it.
 */
export function matchTotp(
  secretB32: string,
  code: string,
  nowMs: number = Date.now(),
): number | null {
  if (typeof code !== 'string' || !CODE_SHAPE.test(code)) return null;
  const delta = totpFor(secretB32).validate({
    token: code,
    timestamp: nowMs,
    window: TOTP_WINDOW,
  });
  if (delta === null) return null;
  return Math.floor(nowMs / PERIOD_MS) + delta;
}
