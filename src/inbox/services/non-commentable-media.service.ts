import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { inboxNonCommentableMedia } from '../../drizzle/schema';

/**
 * Which media this channel has already been told has no comments edge.
 *
 * ## The bug this closes
 *
 * Meta answers `(#100) nonexisting field (comments)` for a Story, a deleted
 * post, or a media whose edge is not named `comments`. Both the Facebook and
 * Instagram services catch that and return no comments rather than failing the
 * poll — the handling was already correct. What was missing was memory: the
 * inbox poller asks every recent post on every cycle, so the same Story was
 * asked **20,169 times in seven days** (every 30 seconds), each one a wasted
 * call against a rate-limited platform and a row in `error_logs`.
 *
 * ## Fail-open, deliberately
 *
 * Every method here swallows its own errors. A database blip must not stop
 * comment ingestion: the worst case of a failed read is that this cycle polls
 * a Story it could have skipped — today's behaviour — while the worst case of
 * throwing would be an inbox that stops updating.
 *
 * That is the same direction the YouTube budget gate already chose in
 * `inbox-poll.processor.ts`, and for the same stated reason: *"polling nothing
 * degrades silently"*.
 */
@Injectable()
export class NonCommentableMediaService {
  private readonly logger = new Logger(NonCommentableMediaService.name);

  /**
   * The subset of `platformPostIds` already known to have no comments edge.
   *
   * Takes the ids being considered rather than reading the whole channel, so
   * the query stays proportional to the poll and not to how long the channel
   * has existed.
   */
  async knownFor(
    channelId: number,
    platformPostIds: readonly string[],
  ): Promise<Set<string>> {
    if (platformPostIds.length === 0) return new Set();

    try {
      const rows = await db
        .select({ platformPostId: inboxNonCommentableMedia.platformPostId })
        .from(inboxNonCommentableMedia)
        .where(
          and(
            eq(inboxNonCommentableMedia.channelId, channelId),
            inArray(
              inboxNonCommentableMedia.platformPostId,
              platformPostIds as string[],
            ),
          ),
        );
      return new Set(rows.map((r) => r.platformPostId));
    } catch (error) {
      this.logger.warn(
        `Could not read non-commentable media for channel ${channelId}; polling all of them this cycle: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return new Set();
    }
  }

  /**
   * Record that the platform says this media has no comments edge.
   *
   * `ON CONFLICT DO NOTHING` against the unique index, so two concurrent polls
   * discovering the same Story cannot write it twice and neither has to check
   * first.
   */
  async remember(
    channelId: number,
    platformPostId: string,
    reason: string,
  ): Promise<void> {
    try {
      await db
        .insert(inboxNonCommentableMedia)
        .values({ channelId, platformPostId, reason })
        .onConflictDoNothing();
    } catch (error) {
      // Losing this write costs one more poll of one media next cycle. It must
      // never cost the comments that were just fetched.
      this.logger.warn(
        `Could not record non-commentable media ${platformPostId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
