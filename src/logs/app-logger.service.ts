import { ConsoleLogger, Injectable } from '@nestjs/common';
import type { LogWriterService } from './log-writer.service';

/**
 * The app's logger. Console behaviour is unchanged (it extends ConsoleLogger);
 * additionally, error() and warn() persist a row via LogWriterService. log(),
 * debug() and verbose() are console-only — capturing info/debug would be a
 * per-call DB write for no signal.
 *
 * The writer is set after construction because the logger is installed during
 * bootstrap (app.useLogger) before we resolve providers from the container.
 */
/** A logged error object can be a whole HTTP response; keep rows bounded. */
const MAX_MESSAGE_LENGTH = 4000;

@Injectable()
export class AppLoggerService extends ConsoleLogger {
  private writer?: LogWriterService;

  setWriter(writer: LogWriterService): void {
    this.writer = writer;
  }

  /**
   * Nest calls error(message, stack, context), but code across the app also
   * calls `logger.error('Failed to …:', error)` with the caught error OBJECT
   * as the second argument. Only a string can be a stack or a context; any
   * other value is detail that belongs with the message. Treating it as a
   * string threw "value.includes is not a function" inside the catch block,
   * which replaced the real platform error the user should have seen.
   */
  error(message: unknown, stackOrContext?: unknown, context?: string): void {
    super.error(
      message as string,
      stackOrContext as string,
      context as string,
    );
    const asString =
      typeof stackOrContext === 'string' ? stackOrContext : undefined;
    const detail =
      stackOrContext === undefined || asString !== undefined
        ? undefined
        : stackOrContext;
    // With no stack the second string is the context instead — normalise both.
    const ctx =
      context ??
      (asString && !this.looksLikeStack(asString) ? asString : undefined);
    const stack =
      asString && this.looksLikeStack(asString)
        ? asString
        : detail instanceof Error
          ? detail.stack
          : undefined;
    const text =
      detail === undefined || detail === null
        ? this.asMessage(message)
        : `${this.asMessage(message)} ${this.asMessage(detail)}`;
    this.writer?.write({
      level: 'error',
      message: text.slice(0, MAX_MESSAGE_LENGTH),
      context: ctx ?? this.context ?? null,
      stack: stack ?? null,
    });
  }

  warn(message: unknown, context?: string): void {
    super.warn(message as string, context as string);
    this.writer?.write({
      level: 'warn',
      message: this.asMessage(message),
      context: context ?? this.context ?? null,
    });
  }

  private asMessage(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  private looksLikeStack(value: string): boolean {
    return value.includes('\n') && value.includes('    at ');
  }
}
