import { Inject, Injectable } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs, type LogLevel } from '../drizzle/schema';

export interface LogWriteEntry {
  level: LogLevel;
  message: string;
  context?: string | null;
  stack?: string | null;
  path?: string | null;
  method?: string | null;
  statusCode?: number | null;
  userId?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The single write path for the logs table. Deliberately fire-and-forget: it is
 * never awaited on a request, and it swallows ALL of its own failures to a plain
 * console.warn. It must never throw and must never route a failure back through
 * the app logger — a logging failure that logged itself would loop forever.
 */
@Injectable()
export class LogWriterService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  write(entry: LogWriteEntry): void {
    // Truncate defensively — a runaway message/stack shouldn't blow the row.
    const message = (entry.message ?? '').slice(0, 10_000);
    const stack = entry.stack ? entry.stack.slice(0, 20_000) : null;

    void this.db
      .insert(errorLogs)
      .values({
        level: entry.level,
        message,
        context: entry.context ?? null,
        stack,
        path: entry.path ?? null,
        method: entry.method ?? null,
        statusCode: entry.statusCode ?? null,
        userId: entry.userId ?? null,
        workspaceId: entry.workspaceId ?? null,
        metadata: entry.metadata ?? {},
      })
      .catch((err: unknown) => {
        // Plain console only — never back into the app logger.
        // eslint-disable-next-line no-console
        console.warn(
          '[LogWriterService] failed to persist a log:',
          err instanceof Error ? err.message : err,
        );
      });
  }
}
