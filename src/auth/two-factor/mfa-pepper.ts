import { Logger } from '@nestjs/common';

/**
 * The server pepper for backup-code hashes (`MFA_CODE_PEPPER`).
 *
 * Every environment except NODE_ENV=development|test refuses to boot without
 * one of at least 32 characters (fail closed, so a deploy with no NODE_ENV
 * is refused too): a missing pepper would mean hashing with a public
 * default, and a short one is guessable. In development and test a fixed dev
 * default keeps local setups working, with one warning so it is not missed.
 *
 * Never rotate it: every stored backup code is an HMAC under it, so a new
 * pepper silently invalidates all of them.
 */

const MIN_LENGTH = 32;
const DEV_DEFAULT = 'dev-only-mfa-code-pepper-not-for-production';

/** Only these may fall back to the dev default; anything else fails closed. */
const DEV_ENVIRONMENTS = new Set(['development', 'test']);

export function resolveMfaPepper(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MFA_CODE_PEPPER;
  // Fail closed: production, staging, and an unset or misspelt NODE_ENV all
  // require a real pepper. A deploy that forgets NODE_ENV must refuse to boot
  // rather than key every backup code with a default that is in the repo.
  if (!DEV_ENVIRONMENTS.has(env.NODE_ENV ?? '')) {
    if (!value || value.length < MIN_LENGTH) {
      throw new Error(
        `MFA_CODE_PEPPER must be set to ${MIN_LENGTH}+ random characters ` +
          `(NODE_ENV is "${env.NODE_ENV ?? ''}"; only development and test ` +
          'may use the default). HMAC pepper for two-step backup codes.',
      );
    }
    return value;
  }
  if (value) return value;
  new Logger('MfaPepper').warn(
    `MFA_CODE_PEPPER is not set; using the development default "${DEV_DEFAULT}". ` +
      'Set it before deploying.',
  );
  return DEV_DEFAULT;
}
