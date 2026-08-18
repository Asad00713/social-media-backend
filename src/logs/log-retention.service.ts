import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs } from '../drizzle/schema';

const RETENTION_DAYS = 30;

@Injectable()
export class LogRetentionService {
  // Plain Logger here is fine: this class's own logs are low-volume and, even if
  // persisted, wouldn't loop (it deletes rows, it doesn't fail-and-log-and-fail).
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<number> {
    const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
    const deleted = await this.db
      .delete(errorLogs)
      .where(lt(errorLogs.createdAt, cutoff))
      .returning({ id: errorLogs.id });
    if (deleted.length > 0) {
      this.logger.log(
        `Purged ${deleted.length} log rows older than ${RETENTION_DAYS}d`,
      );
    }
    return deleted.length;
  }
}
