import { Logger } from '@nestjs/common';

/**
 * The server pepper for backup-code hashes (`MFA_CODE_PEPPER`).
 *
 * Production refuses to boot without one of at least 32 characters: a
 * missing pepper would mean every environment hashes with the same public
 * default, and a short one is guessable. Outside production a fixed dev
 * default keeps local setups working, with one warning so it is not missed.
 *
 * Never rotate it: every stored backup code is an HMAC under it, so a new
 * pepper silently invalidates all of them.
 */

const MIN_LENGTH = 32;
const DEV_DEFAULT = 'dev-only-mfa-code-pepper-not-for-production';

export function resolveMfaPepper(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MFA_CODE_PEPPER;
  if (env.NODE_ENV === 'production') {
    if (!value || value.length < MIN_LENGTH) {
      throw new Error(
        `MFA_CODE_PEPPER must be set to ${MIN_LENGTH}+ random characters in production ` +
          '(HMAC pepper for two-step backup codes).',
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
