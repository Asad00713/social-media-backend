import { BadRequestException } from '@nestjs/common';

export type RefusalCode =
  | 'POST_ALREADY_PUBLISHED'
  | 'POST_PARTLY_PUBLISHED'
  | 'SCHEDULE_IN_PAST';

/**
 * A 400 whose body keeps the standard Nest shape `{ statusCode, message,
 * error }` and adds a machine-readable `code`. Nest sends an object response
 * as-is, so the standard fields must be spelled out.
 */
export function refusal(message: string, code: RefusalCode) {
  return new BadRequestException({
    statusCode: 400,
    message,
    error: 'Bad Request',
    code,
  });
}
