import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LogWriterService } from './log-writer.service';

/**
 * Global exception filter. It preserves Nest's default response exactly — same
 * status and body a client would otherwise get — and additionally persists a
 * row. 5xx are 'error'; 4xx are 'warn' (a validation 400 is worth seeing, not
 * worth alerting on). The DB write is fire-and-forget and can never change or
 * block the response.
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

    const message =
      exception instanceof Error ? exception.message : 'Unknown error';
    const stack = exception instanceof Error ? exception.stack : undefined;

    // Persist (guarded, fire-and-forget). Never let this affect the response.
    try {
      const user = (
        request as unknown as {
          user?: { userId?: string; workspaceId?: string };
        }
      ).user;
      this.writer.write({
        level: status >= 500 ? 'error' : 'warn',
        message,
        context: 'HTTP',
        stack: stack ?? null,
        path: request?.url ?? null,
        method: request?.method ?? null,
        statusCode: status,
        userId: user?.userId ?? null,
        workspaceId: user?.workspaceId ?? null,
      });
    } catch {
      // ignore — logging must not break the response
    }

    // Reproduce Nest's default response shape.
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    response.status(status).json(body);
  }
}
