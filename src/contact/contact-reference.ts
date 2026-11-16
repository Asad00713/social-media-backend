import { randomBytes } from 'node:crypto';

/** Crockford base32: digits and letters without I, L, O and U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_CHARS = 6;

/**
 * `SCH-` and 6 random Crockford base32 characters ('SCH-7QK2M9'): quoted in
 * the acknowledgement, in the enquiry's subject and in both idempotency keys.
 * There is no contact table, so the reference is the only handle on a message.
 * A byte holds 8 bits and the alphabet 5, so `& 31` picks each character
 * uniformly.
 */
export function newContactReference(): string {
  let chars = '';
  for (const byte of randomBytes(REFERENCE_CHARS)) {
    chars += CROCKFORD[byte & 31];
  }
  return `SCH-${chars}`;
}
