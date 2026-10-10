import { BadRequestException } from '@nestjs/common';

/** Wrong guesses allowed against one code before it is cancelled. */
export const MAX_CODE_ATTEMPTS = 5;

export type VerificationCodeErrorCode =
  | 'CODE_INVALID'
  | 'CODE_LOCKED'
  | 'CODE_EXPIRED'
  | 'CODE_COOLDOWN';

/**
 * Always a 400. The frontend's API client answers any 401 by refreshing the
 * session and replaying the request, so a wrong code sent back as 401 would be
 * submitted twice and burn two attempts.
 */
export function verificationCodeError(
  code: VerificationCodeErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
    ...extra,
  });
}
