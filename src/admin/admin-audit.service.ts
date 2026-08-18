import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  adminAuditLogs,
  users,
  type AuditAction,
  type AuditTargetType,
} from '../drizzle/schema';

export interface AuditRecordEntry {
  action: AuditAction;
  actorId: string;
  targetType: AuditTargetType;
  targetId: string;
  targetLabel?: string | null;
  reason?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_NOTE = 5000;
const MAX_LABEL = 255;

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Write one audit row. Call AFTER the underlying mutation has succeeded — a
   * failed action must not leave an audit row. Never throws and never rolls
   * back the caller's action: a write failure is logged as a warning (which
   * itself lands in error_logs) and swallowed.
   */
  async record(entry: AuditRecordEntry): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, entry.actorId),
        columns: { email: true },
      });

      await this.db.insert(adminAuditLogs).values({
        action: entry.action,
        actorId: entry.actorId,
        actorEmail: actor?.email ?? null,
        targetType: entry.targetType,
        targetId: entry.targetId,
        targetLabel: entry.targetLabel?.slice(0, MAX_LABEL) ?? null,
        reason: entry.reason ?? null,
        note: entry.note?.slice(0, MAX_NOTE) ?? null,
        metadata: entry.metadata ?? {},
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write audit log for ${entry.action} on ${entry.targetType}:${entry.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
