import { decrypt, encrypt } from './encryption.util';

/**
 * TOTP secrets at rest (spec §7.2).
 *
 * `encryption.util.ts` is lenient on purpose for OAuth tokens: `decrypt`
 * passes a value with no colon straight through (legacy plaintext rows) and
 * `encrypt('')` returns `''`. For a TOTP seed that leniency is a hole: a
 * plaintext or tampered column would quietly become a working seed. This file
 * wraps both strictly — a value that is not exactly `iv:tag:ct` with three
 * non-empty parts, or that fails GCM authentication, throws
 * `TotpSecretCorruptError` and never verifies anything.
 */

export class TotpSecretCorruptError extends Error {
  constructor(message = 'Stored two-step secret is unreadable') {
    super(message);
    this.name = 'TotpSecretCorruptError';
  }
}

export function encryptTotpSecret(secretB32: string): string {
  if (!secretB32)
    throw new TotpSecretCorruptError('Refusing to store an empty secret');
  return encrypt(secretB32);
}

export function decryptStrict(value: string): string {
  if (typeof value !== 'string' || !value) throw new TotpSecretCorruptError();
  const parts = value.split(':');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new TotpSecretCorruptError();
  }
  let plain: string;
  try {
    plain = decrypt(value);
  } catch {
    throw new TotpSecretCorruptError();
  }
  if (!plain) throw new TotpSecretCorruptError();
  return plain;
}
