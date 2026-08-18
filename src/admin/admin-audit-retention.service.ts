import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { adminAuditLogs } from '../drizzle/schema';

const RETENTION_DAYS = 365;

@Injectable()
export class AdminAuditRetentionService {
  private readonly logger = new Logger(AdminAuditRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  // 3:30 AM, offset from the error-logs 3 AM purge so the two don't collide.
  @Cron('30 3 * * *')
  async purgeOld(): Promise<void> {
    try {
      const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
      await this.db.delete(adminAuditLogs).where(lt(adminAuditLogs.createdAt, cutoff));
    } catch (err) {
      this.logger.warn(
        `Audit retention purge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
