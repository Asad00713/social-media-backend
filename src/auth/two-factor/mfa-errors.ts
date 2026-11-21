import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The wire errors of two-step sign-in (R5). A wrong second factor is NEVER
 * a 401: the frontend's API client replays a 401 through /auth/refresh and
 * may sign the person out. Body: `{ statusCode, error, code, message, ...extra }`.
 */
const ERROR_TEXT: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
};

function mfaError(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException(
    { statusCode: status, error: ERROR_TEXT[status], code, message, ...extra },
    status,
  );
}

export function mfaCodeInvalid(attemptsLeft?: number): HttpException {
  return mfaError(
    HttpStatus.BAD_REQUEST,
    'MFA_CODE_INVALID',
    "That code didn't work.",
    attemptsLeft === undefined ? {} : { attemptsLeft },
  );
}

export function mfaChallengeExpired(): HttpException {
  return mfaError(
    HttpStatus.BAD_REQUEST,
    'MFA_CHALLENGE_EXPIRED',
    'Your sign-in timed out. Sign in again.',
  );
}

export function mfaLocked(retryAfterSeconds: number): HttpException {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return mfaError(
    HttpStatus.TOO_MANY_REQUESTS,
    'MFA_LOCKED',
    `Too many tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfterSeconds: seconds },
  );
}

export function mfaCodeRequired(
  message = 'Enter the code from your authenticator app or a backup code.',
): HttpException {
  return mfaError(HttpStatus.BAD_REQUEST, 'MFA_CODE_REQUIRED', message);
}

/** Both a code and a backup code were sent (contract table). */
export function mfaCodeAmbiguous(): HttpException {
  return mfaCodeRequired('Send a code or a backup code, not both.');
}

export function reauthRequired(): HttpException {
  return mfaError(
    HttpStatus.FORBIDDEN,
    'REAUTH_REQUIRED',
    'Sign in again to continue.',
  );
}

export function mfaNotEnabled(): HttpException {
  return mfaError(
    HttpStatus.CONFLICT,
    'MFA_NOT_ENABLED',
    'Two-step sign-in is off.',
  );
}

export function mfaAlreadyEnabled(): HttpException {
  return mfaError(
    HttpStatus.CONFLICT,
    'MFA_ALREADY_ENABLED',
    'Two-step sign-in is already on.',
  );
}

export function mfaSetupMissing(): HttpException {
  return mfaError(
    HttpStatus.BAD_REQUEST,
    'MFA_SETUP_MISSING',
    'Start setup again.',
  );
}

export function sessionIsCurrent(): HttpException {
  return mfaError(
    HttpStatus.BAD_REQUEST,
    'SESSION_IS_CURRENT',
    "This is the session you're using. Log out instead.",
  );
}

/** The `code` of an error thrown by one of the helpers above, else undefined. */
export function mfaCodeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? String((body as { code: unknown }).code)
    : undefined;
}
