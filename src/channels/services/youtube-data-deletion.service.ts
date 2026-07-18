import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

export interface YoutubeDeletionSummary {
  inboxItems: number;
  postMetricSnapshots: number;
  channelSnapshots: number;
  channelAnalyticsDaily: number;
}

/**
 * Deletes every piece of YouTube-derived data we hold for a channel, on the
 * user's explicit request.
 *
 * YouTube Developer Policy III.E.4 requires a way for a user to request deletion
 * of their stored data, honored within 7 days. Disconnecting a channel already
 * achieves this through the cascade, but that is a side-effect of disconnecting
 * rather than a stated capability — and a side-effect cannot be demonstrated to
 * an auditor. This makes it an explicit, reportable operation.
 *
 * NOTE the difference from YoutubeRetentionService, which is deliberate and
 * should not be "simplified" away: the retention job leaves the analytics tables
 * alone, because III.E.4.b permits keeping analytics and statistics indefinitely
 * while we remain authorized. Here the user is explicitly withdrawing, so those
 * tables go too.
 *
 * Ordered child-first so foreign keys never block the delete, and wrapped in a
 * transaction so a failure part-way cannot leave the user half-deleted.
 *
 * `post_metric_snapshots`, `channel_snapshots`, and `channel_analytics_daily`
 * have no `workspace_id` column of their own, so each of those DELETEs scopes
 * itself through a `channel_id IN (SELECT id FROM social_media_channels WHERE
 * id = ... AND workspace_id = ...)` subquery. This is deliberate — it is what
 * guarantees the workspace boundary even if a future caller (admin tool, cron
 * cleanup, bulk job) invokes this method without first re-validating channel
 * ownership the way the controller does today. Do NOT "simplify" the subquery
 * down to a bare `channel_id = ${channelId}` — that would silently drop the
 * tenant isolation this method's signature implies it already provides.
 */
@Injectable()
export class YoutubeDataDeletionService {
  private readonly logger = new Logger(YoutubeDataDeletionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async deleteAllYoutubeData(
    channelId: number,
    workspaceId: string,
  ): Promise<YoutubeDeletionSummary> {
    const summary = await this.db.transaction(async (tx: any) => {
      const count = async (statement: any): Promise<number> => {
        const result: any = await tx.execute(statement);
        return Number(result?.rowCount ?? 0);
      };

      const inboxItems = await count(sql`
        DELETE FROM inbox_items
        WHERE channel_id = ${channelId}
          AND workspace_id = ${workspaceId}
          AND platform = 'youtube'
      `);

      const postMetricSnapshots = await count(sql`
        DELETE FROM post_metric_snapshots
        WHERE channel_id IN (
          SELECT id FROM social_media_channels
          WHERE id = ${channelId} AND workspace_id = ${workspaceId}
        )
      `);

      const channelSnapshots = await count(sql`
        DELETE FROM channel_snapshots
        WHERE channel_id IN (
          SELECT id FROM social_media_channels
          WHERE id = ${channelId} AND workspace_id = ${workspaceId}
        )
      `);

      const channelAnalyticsDaily = await count(sql`
        DELETE FROM channel_analytics_daily
        WHERE channel_id IN (
          SELECT id FROM social_media_channels
          WHERE id = ${channelId} AND workspace_id = ${workspaceId}
        )
      `);

      return {
        inboxItems,
        postMetricSnapshots,
        channelSnapshots,
        channelAnalyticsDaily,
      };
    });

    this.logger.log(
      `YouTube data deletion for channel ${channelId} (workspace ${workspaceId}): ` +
        `inbox=${summary.inboxItems} postMetrics=${summary.postMetricSnapshots} ` +
        `channelSnapshots=${summary.channelSnapshots} analyticsDaily=${summary.channelAnalyticsDaily}`,
    );

    return summary;
  }

  /**
   * Deactivates the channel so ingestion actually stops after a data-deletion
   * request.
   *
   * Deliberately a separate method rather than folded into
   * `deleteAllYoutubeData` — that method's signature is depended on elsewhere
   * and is not to change. Without this, `connection_status` stayed
   * 'connected' and `is_active` stayed true, so `InboxPollScheduler` would
   * re-ingest comments on the very next poll (~30s), making the delete
   * endpoint's "your data has been deleted" response false within seconds —
   * exactly the demo that fails a policy audit.
   *
   * This does not delete the channel row (that remains `deleteChannel`'s
   * job) — it stops the row from acting as a live, polled connection.
   */
  async deactivateChannel(channelId: number, workspaceId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE social_media_channels
      SET connection_status = 'expired',
          is_active = false,
          last_error = 'YouTube data was deleted by user request — channel deactivated to prevent re-ingestion. Reconnect to resume.',
          updated_at = NOW()
      WHERE id = ${channelId} AND workspace_id = ${workspaceId}
    `);
    this.logger.log(
      `Channel ${channelId} (workspace ${workspaceId}) deactivated after YouTube data deletion request`,
    );
  }
}
