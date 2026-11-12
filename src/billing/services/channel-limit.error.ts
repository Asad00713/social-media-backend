import { ForbiddenException, HttpException } from '@nestjs/common';

export const CHANNEL_LIMIT_REACHED = 'CHANNEL_LIMIT_REACHED' as const;

/**
 * The 403 for "no channel slot left". The body keeps Nest's standard
 * `{ statusCode, error, message }` (an object response is sent as-is, so the
 * standard fields are spelled out, as WORKSPACE_SUSPENDED does) and adds a
 * machine-readable `code` with the numbers, so the Channels page can open the
 * upgrade dialog instead of parsing the message.
 */
export function channelLimitReached(
  used: number,
  limit: number,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: CHANNEL_LIMIT_REACHED,
    used,
    limit,
    message:
      `Channel limit reached (${used}/${limit}). ` +
      'Upgrade your plan or purchase additional channels.',
  });
}

/** The machine-readable `code` of a Nest HttpException body, if it has one. */
export function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const body = err.getResponse();
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
