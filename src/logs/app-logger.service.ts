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
@Injectable()
export class AppLoggerService extends ConsoleLogger {
  private writer?: LogWriterService;

  setWriter(writer: LogWriterService): void {
    this.writer = writer;
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    super.error(
      message as string,
      stackOrContext as string,
      context as string,
    );
    // Nest calls error(message, stack, context). With no stack the second arg
    // is the context instead — normalise both shapes.
    const ctx =
      context ??
      (stackOrContext && !this.looksLikeStack(stackOrContext)
        ? stackOrContext
        : undefined);
    const stack =
      stackOrContext && this.looksLikeStack(stackOrContext)
        ? stackOrContext
        : undefined;
    this.writer?.write({
      level: 'error',
      message: this.asMessage(message),
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
