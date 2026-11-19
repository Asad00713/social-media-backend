import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { LogWriterService } from './log-writer.service';
import { redactTokenUrls } from './redact-token-urls';
import { redactSensitivePath } from './redact-path';
import { currentRequestId } from './request-context';

/**
 * Global exception filter. It preserves Nest's default response — same status
 * and body a client would otherwise get, plus one additive `requestId` field
 * (the request's X-Request-Id, see request-context.ts) — and additionally
 * persists a row carrying the same id. 5xx are 'error'; 4xx are 'warn' (a validation 400 is worth seeing, not
 * worth alerting on). The DB write is fire-and-forget and can never change or
 * block the response. Token-bearing URLs (email and report links) are stored
 * with the token replaced by [token].
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly writer: LogWriterService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const requestId = request?.requestId ?? currentRequestId();

    // Nest's own route-not-found 404 spells the URL in its message ("Cannot
    // POST /public/connect-links/<token>"), and the stack repeats the
    // message, so both get the same redaction as the path.
    const message = redactSensitivePath(
      exception instanceof Error ? exception.message : 'Unknown error',
    );
    const stack =
      exception instanceof Error && exception.stack
        ? redactSensitivePath(exception.stack)
        : undefined;

    // Persist (guarded, fire-and-forget). Never let this affect the response.
    try {
      const user = (
        request as unknown as {
          user?: { userId?: string; workspaceId?: string };
        }
      ).user;
      this.writer.write({
        level: status >= 500 ? 'error' : 'warn',
        message: redactTokenUrls(message),
        context: 'HTTP',
        stack: stack ? redactTokenUrls(stack) : null,
        // Some routes carry a bearer token in the path; never persist it.
        path: request?.url
          ? redactTokenUrls(redactSensitivePath(request.url))
          : null,
        method: request?.method ?? null,
        statusCode: status,
        userId: user?.userId ?? null,
        workspaceId: user?.workspaceId ?? null,
        requestId: requestId ?? null,
      });
    } catch {
      // ignore — logging must not break the response
    }

    // Report to Sentry — 5xx only. A 4xx is the client being wrong (a bad
    // payload, a missing resource, an expired token); alerting on those buries
    // the failures that are ours under noise we cannot act on. They are still
    // written to error_logs above, which stays the system of record.
    if (status >= 500) {
      try {
        const user = (
          request as unknown as {
            user?: { userId?: string; workspaceId?: string };
          }
        ).user;

        Sentry.withScope((scope) => {
          if (user?.userId) scope.setUser({ id: user.userId });
          if (user?.workspaceId) scope.setTag('workspace', user.workspaceId);
          if (requestId) scope.setTag('request_id', requestId);
          // The path is a tag rather than part of the message so Sentry groups
          // by the thrown error, not by every distinct URL that produced it.
          if (request?.url) {
            scope.setTag(
              'path',
              redactTokenUrls(redactSensitivePath(request.url)),
            );
          }
          Sentry.captureException(exception);
        });
      } catch {
        // Same contract as the DB write above: observability must never be
        // able to change or break the response.
      }
    }

    // Reproduce Nest's default response shape (BaseExceptionFilter: an object
    // response goes out as is, a string one as { statusCode, message }), then
    // add the request id.
    const raw: unknown =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };
    const body: Record<string, unknown> =
      raw !== null && typeof raw === 'object'
        ? { ...(raw as Record<string, unknown>) }
        : { statusCode: status, message: raw };
    if (requestId) body.requestId = requestId;

    response.status(status).json(body);
  }
}
