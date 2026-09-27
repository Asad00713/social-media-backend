import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';

// Keep one week of error/warn logs. The table is high-volume (six figures a
// day observed in production), so this is a hot table, not an archive — a
// shorter window keeps it small enough that the daily purge and its indexes
// stay cheap.
const RETENTION_DAYS = 7;

// Delete in chunks rather than one statement. A single DELETE of a day's worth
// of rows takes a long-held lock and bloats the WAL; a bounded loop keeps each
// transaction small so writes are never blocked for long.
const DELETE_BATCH_SIZE = 20_000;

// A safety ceiling so a runaway table can't spin the loop forever in one run.
// At 20k/batch this is 4M rows — far past a normal day — and the remainder is
// caught by the next run.
const MAX_BATCHES = 200;

@Injectable()
export class LogRetentionService {
  // Plain Logger here is fine: this class's own logs are low-volume and, even if
  // persisted, wouldn't loop (it deletes rows, it doesn't fail-and-log-and-fail).
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<number> {
    let total = 0;

    try {
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        // ctid keyset: delete the physically-first N expired rows each pass.
        // Cheaper than an id IN (...) subquery and needs no ordering.
        const result = await this.db.execute(sql`
          DELETE FROM error_logs
          WHERE ctid IN (
            SELECT ctid FROM error_logs
            WHERE created_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'
            LIMIT ${DELETE_BATCH_SIZE}
          )
        `);

        const affected = result.rowCount ?? 0;
        total += affected;
        if (affected < DELETE_BATCH_SIZE) break;
      }

      if (total > 0) {
        this.logger.log(
          `Purged ${total} log rows older than ${RETENTION_DAYS}d`,
        );
        // Reclaim the space the delete freed. A plain VACUUM (never FULL) takes
        // no exclusive lock — it returns dead tuples to the free list so the
        // table stops growing on disk. FULL would lock the table and belongs in
        // a manual maintenance window, not a nightly cron.
        await this.db.execute(sql`VACUUM error_logs`);
      }
    } catch (err) {
      this.logger.warn(
        `Log retention purge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return total;
  }
}
