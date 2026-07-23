import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

/**
 * YouTube Developer Policy III.E.4.c: Authorized Data other than analytics and
 * statistics must be deleted or refreshed within 30 calendar days.
 */
export const YOUTUBE_RETENTION_DAYS = 30;

export interface RetentionResult {
  wiped: number;
  /** The boundary actually used, returned so callers and tests can assert on it. */
  cutoff: Date;
}

/**
 * Nulls identifying content on YouTube inbox rows older than 30 days.
 *
 * The ROW SURVIVES. Only the columns that identify a YouTube user or carry
 * their words are nulled: the comment text, the author's display name, avatar,
 * handle, and channel id. Everything else — read/replied status, like count,
 * threading pointers, timestamps — is kept, so a user's inbox history and the
 * fact that they replied to something are not destroyed by a policy job.
 *
 * `metadata.authorChannelUrl` is also stripped. `YoutubeInboxAdapter` stores
 * `https://www.youtube.com/channel/UC…` there (see
 * `src/inbox/adapters/youtube-inbox.adapter.ts`), which is exactly the same
 * identifying channel id as `author_platform_id` in URL form — nulling the
 * column while leaving this key in the surviving jsonb would leave the
 * commenter fully identifiable and defeat the whole wipe.
 *
 * Two things here are load-bearing:
 *
 *   1. `platform = 'youtube'`. This obligation is YouTube's alone. Applying it
 *      to Facebook, Instagram, Bluesky, Mastodon or Threads rows would delete
 *      those users' data for no reason at all.
 *
 *   2. The window is measured from `platform_created_at` — when the comment was
 *      posted on YouTube — NOT from `created_at`, when our row happened to be
 *      inserted. A comment ingested today but posted 40 days ago is already
 *      expired. Measuring from insert time would both retain expired data and,
 *      during any backfill, destroy fresh data.
 *
 * Analytics tables (channel_snapshots, channel_analytics_daily,
 * post_metric_snapshots) are III.E.4.b data, storable indefinitely subject only
 * to the 30-day authorization re-check. This job must never touch them.
 *
 * Idempotent: already-wiped rows are excluded by the `text IS NOT NULL` guard,
 * so a second run in the same day reports 0 rather than re-counting.
 */
@Injectable()
export class YoutubeRetentionService {
  private readonly logger = new Logger(YoutubeRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async wipeExpiredContent(now: Date = new Date()): Promise<RetentionResult> {
    const cutoff = new Date(
      now.getTime() - YOUTUBE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const cutoffIso = cutoff.toISOString();

    const result: any = await this.db.execute(sql`
      UPDATE inbox_items
      SET
        text = NULL,
        author_display_name = NULL,
        author_avatar_url = NULL,
        author_handle = NULL,
        author_platform_id = NULL,
        metadata = metadata - 'authorChannelUrl'
      WHERE platform = 'youtube'
        AND platform_created_at < ${cutoffIso}
        AND (
          text IS NOT NULL
          OR author_display_name IS NOT NULL
          OR author_avatar_url IS NOT NULL
          OR author_handle IS NOT NULL
          OR author_platform_id IS NOT NULL
          OR metadata ? 'authorChannelUrl'
        )
    `);

    const wiped = Number(result?.rowCount ?? 0);
    if (wiped > 0) {
      this.logger.log(
        `YouTube retention: wiped content on ${wiped} inbox items older than ` +
          `${YOUTUBE_RETENTION_DAYS} days (cutoff ${cutoffIso})`,
      );
    }
    return { wiped, cutoff };
  }
}
