import { sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';

/**
 * SQL that recomputes every workspace's billable channel count from the
 * category column. Extracted so it can be unit-tested without a DB. Deletes are
 * hard deletes (no is_active filter). LEFT JOIN + COALESCE(...,0) sets
 * zero-billable workspaces to 0 rather than leaving them stale.
 */
export function buildRecomputeSql(): string {
  return `
    UPDATE workspace_usage wu
    SET channels_count = COALESCE(sub.cnt, 0), updated_at = now()
    FROM workspace_usage all_ws
    LEFT JOIN (
      SELECT workspace_id, count(*) AS cnt
      FROM social_media_channels
      WHERE category <> 'integration'
      GROUP BY workspace_id
    ) sub ON sub.workspace_id = all_ws.workspace_id
    WHERE wu.workspace_id = all_ws.workspace_id;
  `;
}

/**
 * Recompute billable channel counts for all workspaces. Idempotent — running it
 * twice yields identical counts. NOT wired to run automatically; invoke manually
 * (e.g. an admin endpoint or one-shot script) only when real data needs
 * correcting. The assistant never runs this against a live DB.
 */
export async function recomputeBillableChannelCounts(): Promise<void> {
  await db.execute(sql.raw(buildRecomputeSql()));
}
