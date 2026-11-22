import { Logger } from '@nestjs/common';

/**
 * The server pepper for backup-code hashes (`MFA_CODE_PEPPER`).
 *
 * Deployed processes refuse to boot without one of at least 32 characters
 * (fail closed): a missing pepper would mean hashing with a public default,
 * and a short one is guessable. "Deployed" is NODE_ENV=production OR any
 * variable Railway injects into every service (RAILWAY_ENVIRONMENT_NAME,
 * RAILWAY_ENVIRONMENT, RAILWAY_PROJECT_ID) - so a Railway service that
 * forgets NODE_ENV, or sets it to anything else, is still refused.
 *
 * Everywhere else (a local machine, whatever NODE_ENV says) a fixed dev
 * default keeps setups working, with one loud warning so it is not missed.
 *
 * Never rotate it: every stored backup code is an HMAC under it, so a new
 * pepper silently invalidates all of them.
 */

const MIN_LENGTH = 32;
const DEV_DEFAULT = 'dev-only-mfa-code-pepper-not-for-production';

/** Railway sets these on every deployment; any one of them means "deployed". */
const RAILWAY_MARKERS = [
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_PROJECT_ID',
] as const;

function deployedReason(env: NodeJS.ProcessEnv): string | null {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    return 'NODE_ENV is production';
  }
  const marker = RAILWAY_MARKERS.find((name) => !!env[name]);
  return marker ? `${marker} is set (Railway)` : null;
}

export function resolveMfaPepper(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MFA_CODE_PEPPER;
  const deployed = deployedReason(env);
  if (deployed) {
    if (!value || value.length < MIN_LENGTH) {
      throw new Error(
        `MFA_CODE_PEPPER must be set to ${MIN_LENGTH}+ random characters ` +
          `(${deployed}; the dev default is only for local machines). ` +
          'HMAC pepper for two-step backup codes.',
      );
    }
    return value;
  }
  if (value) return value;
  new Logger('MfaPepper').warn(
    `MFA_CODE_PEPPER is not set; using the LOCAL DEVELOPMENT default ` +
      `"${DEV_DEFAULT}". Backup codes hashed with it are not secret. ` +
      'Production and Railway refuse to boot without a real pepper.',
  );
  return DEV_DEFAULT;
}
