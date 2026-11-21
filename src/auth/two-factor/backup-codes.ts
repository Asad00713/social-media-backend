import { createHmac, randomBytes } from 'crypto';

/**
 * Backup codes for two-step sign-in (spec §7.2).
 *
 * Ten codes of 8 Crockford base32 symbols (40 bits each), shown `XXXX-XXXX`.
 * Crockford drops I, L, O and U so a code read off paper cannot be misread;
 * input is normalised the Crockford way (O→0, I/L→1) so a person who types
 * the letter still matches. Stored as HMAC-SHA256 with a server pepper, never
 * in the clear: a leaked table alone cannot be brute-forced offline.
 *
 * Hand-rolled on purpose (CLAUDE.md package rule, case 3): this is our own
 * code format; the only library-shaped part is Crockford encoding of 5 bytes,
 * which is eight table lookups.
 */

export const BACKUP_CODE_COUNT = 10;
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CODE_LENGTH = 8;
const VALID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Encodes 5 random bytes as 8 Crockford symbols (8 x 5 bits). */
function oneCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = CODE_LENGTH - 1; i >= 0; i--) {
    out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** `count` distinct display codes (`XXXX-XXXX`). */
export function newBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(oneCode());
  return [...codes];
}

/**
 * Upper-cases, strips dashes and spaces, maps O→0 and I/L→1. Returns the
 * 8-symbol form, or `null` when the result is not a valid code.
 */
export function normalizeBackupCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return VALID.test(s) ? s : null;
}

/** HMAC-SHA256(pepper, normalized) as 64 hex chars. */
export function hashBackupCode(normalized: string, pepper: string): string {
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}
