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
}
