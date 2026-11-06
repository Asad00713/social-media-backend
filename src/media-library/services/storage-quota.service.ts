import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { FREE_STORAGE_BYTES } from '../../billing/plan-storage';
import {
  StorageFullException,
  wouldExceed,
  type StorageUsage,
} from '../lib/storage';

/** Per-workspace Library storage: what is used, what is allowed, who may add. */
@Injectable()
export class StorageQuotaService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * `used` counts every media item of the workspace, Bin included, except
   * samples: their file is one bundled copy shared by every workspace, not
   * this workspace's storage (0057). `limit` is
   * the workspace's own row (plan bytes plus bought add-on bytes) or, without
   * one, the owner's plan: only an active or trialing subscription counts, anything else
   * is FREE (D14, B7).
   */
  async getUsage(
    workspaceId: string,
    db: DbType = this.db,
  ): Promise<StorageUsage> {
    const res = await db.execute<{ used: string; limit: string }>(sql`
      SELECT
        (SELECT COALESCE(SUM(COALESCE(mi.file_size, 0)), 0)
           FROM media_items mi
          WHERE mi.workspace_id = ${workspaceId}::uuid AND NOT mi.is_sample) AS used,
        COALESCE(
          (SELECT wu.storage_bytes_limit + wu.extra_storage_purchased
             FROM workspace_usage wu WHERE wu.workspace_id = ${workspaceId}::uuid),
          (SELECT p.storage_bytes_per_workspace
             FROM workspace w
             LEFT JOIN subscriptions s ON s.user_id = w.owner_id
             JOIN plans p ON p.code = CASE WHEN s.status IN ('active', 'trialing') THEN s.plan_code ELSE 'FREE' END
            WHERE w.id = ${workspaceId}::uuid
            LIMIT 1),
          (SELECT p.storage_bytes_per_workspace FROM plans p WHERE p.code = 'FREE'),
          ${FREE_STORAGE_BYTES}::bigint
        ) AS "limit"
    `);
    const row = res.rows[0];
    return { used: Number(row.used), limit: Number(row.limit) };
  }

  async assertCanStore(
    workspaceId: string,
    incomingBytes: number,
    db?: DbType,
  ): Promise<StorageUsage> {
    const usage = await this.getUsage(workspaceId, db);
    if (wouldExceed(usage.used, incomingBytes, usage.limit)) {
      throw new StorageFullException(usage);
    }
    return usage;
  }

  /** Serialises storage writes of one workspace for the length of `fn`. */
  runLocked<T>(
    workspaceId: string,
    fn: (tx: DbType) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'library-storage:' + workspaceId}, 0))`,
      );
      return fn(tx as unknown as DbType);
    });
  }
}
