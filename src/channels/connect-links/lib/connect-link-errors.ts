import { HttpException } from '@nestjs/common';

/** Machine-readable `code` of every connect-link refusal and its HTTP status. */
export const CONNECT_LINK_ERRORS = {
  LINK_NOT_FOUND: 404,
  LINK_EXPIRED: 410,
  LINK_REVOKED: 410,
  LINK_UNAVAILABLE: 410,
  NETWORK_NOT_OFFERED: 400,
  NO_EMAIL: 400,
  RESEND_TOO_SOON: 429,
  SELECTION_EXPIRED: 410,
  ALREADY_CONNECTED: 409,
  EMAIL_SEND_FAILED: 502,
  CONNECT_FAILED: 502,
} as const;

export type ConnectLinkErrorCode = keyof typeof CONNECT_LINK_ERRORS;

/**
 * A coded HTTP refusal. The body keeps Nest's standard `{ statusCode, error,
 * message }` and adds `code`, the same shape as CHANNEL_LIMIT_REACHED, so the
 * frontend branches on `code` instead of parsing the message.
 */
export function connectLinkError(
  code: ConnectLinkErrorCode,
  message: string,
): HttpException {
  const statusCode = CONNECT_LINK_ERRORS[code];
  return new HttpException(
    { statusCode, error: code, code, message },
    statusCode,
  );
}
