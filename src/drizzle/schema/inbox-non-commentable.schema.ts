import {
  bigint,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';

/**
 * Media the platform has told us has no comments edge.
 *
 * ## Why this exists
 *
 * Both the Facebook and Instagram comment pollers already handle the case
 * gracefully: Meta answers `(#100) nonexisting field (comments)` for a Story,
 * a deleted post, or a media type whose edge is not called `comments`, and
 * both services catch it and return no comments rather than failing the poll.
 *
 * What neither did was **remember**. The inbox poller asks every recent post
 * for comments on every cycle, so one Story was asked 20,169 times in seven
 * days — every 30 seconds, forever. That is 20,169 wasted API calls against a
 * rate-limited platform, and 20,169 rows in `error_logs`, which is the table
 * that reached 738MB once already (BE #128).
 *
 * ## Why a table and not `posts.targets`
 *
 * `posts.targets` is a jsonb array that every writer updates by reading the
 * whole array, changing one entry and writing it back. The publish path, the
 * channel pause/disconnect sweeps and the composer all do this. A poller
 * writing there too would race them, and the loser's write disappears with no
 * error — exactly the read-modify-write bug BE #245 fixed on the usage
 * counters.
 *
 * ## Why a table and not Redis
 *
 * "This media has no comments edge" is a **permanent** fact: a Story will
 * never become commentable, and a deleted post will never come back. Redis
 * holds things that expire. Putting a permanent fact behind a TTL means
 * relearning it — at 20,169 calls — every time the key is evicted or Redis is
 * flushed.
 */
export const inboxNonCommentableMedia = pgTable(
  'inbox_non_commentable_media',
  {
    /**
     * `bigint`, not `uuid`: `social_media_channels.id` is a `bigserial`.
     * Caught by `npm run typecheck` rather than by a test, because the job
     * payload types `channelId` as a number and nothing else noticed.
     */
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    /**
     * The platform's own id for the media (`platformPostId` on a PostTarget).
     * Not a foreign key to `posts`: the same media can be reached from more
     * than one post row, and a post can be hard-deleted while the media still
     * exists on the platform.
     */
    platformPostId: varchar('platform_post_id', { length: 255 }).notNull(),
    /** Which error the platform gave, for when this needs explaining later. */
    reason: varchar('reason', { length: 100 }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    /**
     * The lookup AND the identity. The poller reads one row set per channel
     * per cycle, and the writer inserts with ON CONFLICT DO NOTHING — so two
     * concurrent polls that both discover the same Story cannot write it
     * twice.
     */
    channelMediaIdx: uniqueIndex('inbox_non_commentable_channel_media_idx').on(
      table.channelId,
      table.platformPostId,
    ),
    channelIdx: index('inbox_non_commentable_channel_idx').on(table.channelId),
  }),
);

export type InboxNonCommentableMedia =
  typeof inboxNonCommentableMedia.$inferSelect;
