import { HttpException, HttpStatus } from '@nestjs/common';
import type { SendFailureCode } from '../dto/contract';

/** Body of every failed send/action: `{ code, message, retryable }`. */
export interface SendErrorBody {
  code: SendFailureCode;
  message: string;
  retryable: boolean;
}

export class InboxSendError extends HttpException {
  constructor(status: HttpStatus, body: SendErrorBody) {
    super(body, status);
  }
}

/**
 * The reply-window check refused the send (D19). Thrown by the check itself,
 * so a ForbiddenException from anywhere else (workspace access) is never
 * mistaken for a closed window.
 */
export class ReplyWindowClosedError extends InboxSendError {
  constructor(message = 'Cannot reply to this conversation right now') {
    super(HttpStatus.FORBIDDEN, {
      code: 'REPLY_WINDOW_CLOSED',
      message,
      retryable: false,
    });
  }
}

/** The channel row is not `connected`: the platform call is never attempted. */
export class ChannelNotConnectedError extends Error {
  constructor(
    message = 'This channel is disconnected. Reconnect it to continue.',
  ) {
    super(message);
    this.name = 'ChannelNotConnectedError';
  }
}

const AUTH_FAILURE = /token|expired|revoked|unauthori[sz]ed|401|reconnect/i;
const RATE_LIMIT = /rate|429|too many/i;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Maps whatever a send or platform call threw onto the contract's failure
 * shape. HTTP exceptions the service raised on purpose (404, 400, the
 * REPLIED_FIRST 409, an InboxSendError such as ReplyWindowClosedError) pass
 * through unchanged.
 */
export function toSendError(err: unknown): unknown {
  if (err instanceof HttpException) return err;

  const message = messageOf(err);
  if (err instanceof ChannelNotConnectedError || AUTH_FAILURE.test(message)) {
    return new InboxSendError(HttpStatus.CONFLICT, {
      code: 'CHANNEL_DISCONNECTED',
      message,
      retryable: false,
    });
  }
  if (RATE_LIMIT.test(message)) {
    return new InboxSendError(HttpStatus.TOO_MANY_REQUESTS, {
      code: 'RATE_LIMITED',
      message,
      retryable: true,
    });
  }
  return new InboxSendError(HttpStatus.BAD_GATEWAY, {
    code: 'PLATFORM_ERROR',
    message,
    retryable: true,
  });
}
