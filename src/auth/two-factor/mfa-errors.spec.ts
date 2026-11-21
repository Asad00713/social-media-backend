import type { HttpException } from '@nestjs/common';
import {
  mfaAlreadyEnabled,
  mfaChallengeExpired,
  mfaCodeAmbiguous,
  mfaCodeInvalid,
  mfaCodeOf,
  mfaCodeRequired,
  mfaLocked,
  mfaNotEnabled,
  mfaSetupMissing,
  reauthRequired,
  sessionIsCurrent,
} from './mfa-errors';

const body = (e: HttpException) => e.getResponse() as Record<string, unknown>;

describe('mfa-errors (R5)', () => {
  it.each([
    [mfaCodeInvalid(), 400, 'MFA_CODE_INVALID', "That code didn't work."],
    [
      mfaChallengeExpired(),
      400,
      'MFA_CHALLENGE_EXPIRED',
      'Your sign-in timed out. Sign in again.',
    ],
    [
      mfaCodeRequired(),
      400,
      'MFA_CODE_REQUIRED',
      'Enter the code from your authenticator app or a backup code.',
    ],
    [
      mfaCodeAmbiguous(),
      400,
      'MFA_CODE_REQUIRED',
      'Send a code or a backup code, not both.',
    ],
    [reauthRequired(), 403, 'REAUTH_REQUIRED', 'Sign in again to continue.'],
    [mfaNotEnabled(), 409, 'MFA_NOT_ENABLED', 'Two-step sign-in is off.'],
    [
      mfaAlreadyEnabled(),
      409,
      'MFA_ALREADY_ENABLED',
      'Two-step sign-in is already on.',
    ],
    [mfaSetupMissing(), 400, 'MFA_SETUP_MISSING', 'Start setup again.'],
    [
      sessionIsCurrent(),
      400,
      'SESSION_IS_CURRENT',
      "This is the session you're using. Log out instead.",
    ],
  ] as const)('%#: %s → %s %s', (error, status, code, message) => {
    expect(error.getStatus()).toBe(status);
    expect(body(error)).toMatchObject({ statusCode: status, code, message });
    expect(typeof body(error).error).toBe('string');
    expect(mfaCodeOf(error)).toBe(code);
  });

  it('a wrong code is never a 401 (the FE replays 401 through refresh)', () => {
    for (const e of [mfaCodeInvalid(3), mfaChallengeExpired(), mfaLocked(900)])
      expect(e.getStatus()).not.toBe(401);
  });

  it('MFA_CODE_INVALID carries attemptsLeft only when given', () => {
    expect(body(mfaCodeInvalid(4)).attemptsLeft).toBe(4);
    expect(body(mfaCodeInvalid(0)).attemptsLeft).toBe(0);
    expect(body(mfaCodeInvalid())).not.toHaveProperty('attemptsLeft');
  });

  it('MFA_LOCKED is 429 with retryAfterSeconds and the wait in minutes', () => {
    const e = mfaLocked(899.2);
    expect(e.getStatus()).toBe(429);
    expect(body(e)).toMatchObject({
      code: 'MFA_LOCKED',
      retryAfterSeconds: 900,
      message: 'Too many tries. Try again in 15 minutes.',
    });
    expect(body(mfaLocked(30)).message).toBe(
      'Too many tries. Try again in 1 minute.',
    );
  });

  it('mfaCodeOf is undefined for anything else', () => {
    expect(mfaCodeOf(new Error('x'))).toBeUndefined();
  });
});
