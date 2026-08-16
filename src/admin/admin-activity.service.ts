import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  posts,
  campaigns,
  inboxItems,
  mediaItems,
  adCampaigns,
  workspace,
} from '../drizzle/schema';

/**
 * Platform-wide "recent activity" feeds for the admin dashboard — the newest
 * rows of each domain across every workspace, attributed to the workspace they
 * belong to.
 *
 * These are intentionally thin. Each feed reads a real base table and returns
 * exactly what that table stores; it does not compute the derived metrics a
 * per-workspace product view shows (open rates, reply times, "never used"
 * share, ad spend). Those aren't recorded here — surfacing them would mean
 * inventing numbers — so this layer stops at what is true: what happened, in
 * which workspace, and when.
 *
 * Every feed is cursor-paginated by (createdAt desc, id desc). A keyset cursor,
 * not an offset: these tables grow, and OFFSET would scan and skip more rows on
 * every page while risking duplicates when new rows arrive mid-scroll. The
 * cursor pins the scroll to a row that doesn't move.
 */

// The workspace's name, correlated to each row. Written out as a qualified
// subquery on purpose — a bare join would need aliasing across five feeds, and
// the correlated form keeps each feed a single-table read.
function workspaceNameFor(workspaceIdColumn: unknown) {
  return sql<string>`(
    SELECT ws.name FROM ${workspace} AS ws WHERE ws.id = ${workspaceIdColumn}
  )`;
}

const PAGE_SIZE = 25;

interface CursorRow {
  id: string;
  createdAt: Date | string | null;
}

/** Encode a row into an opaque `<createdAt>_<id>` cursor. */
function encodeCursor(row: CursorRow): string {
  const created =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt);
  return `${created}_${row.id}`;
}

/**
 * Decode a cursor into its parts. Returns null for a malformed cursor so a bad
 * value degrades to "first page" instead of throwing a 500 at the client.
 */
function decodeCursor(
  cursor?: string,
): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf('_');
  if (at <= 0) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

@Injectable()
export class AdminActivityService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * The keyset predicate: rows strictly older than the cursor by (createdAt, id).
   * Null cursor → no predicate (first page). Built once and reused by every feed.
   *
   * Two things have to line up for the boundary row to be excluded exactly once
   * rather than reappearing as a duplicate on the next page:
   *
   * 1. **Precision.** The cursor carries a JS `Date` (millisecond) ISO string,
   *    but the column stores microseconds, so `.175030 ≠ .175000` and the `id`
   *    tiebreak never fires. Truncating the column to milliseconds makes them meet.
   *
   * 2. **Time zone.** `created_at` is `timestamptz` on some feeds (posts, media)
   *    and a naive `timestamp` on others (campaigns, inbox, ads). Casting the
   *    cursor to `timestamptz` against a naive column shifts it by the server's
   *    offset — a 5-hour gap that pulls the boundary row back into the next page.
   *    So `isTz` picks the matching cast; the JS ISO cursor is UTC either way,
   *    which lines up with how Drizzle read the value out.
   */
  private keysetBefore(
    createdAtColumn: AnyPgColumn,
    idColumn: AnyPgColumn,
    cursor: string | undefined,
    isTz: boolean,
  ): SQL | undefined {
    const decoded = decodeCursor(cursor);
    if (!decoded) return undefined;
    // Drop the trailing Z for the naive cast so it isn't read as a UTC instant.
    const cursorTs = isTz
      ? sql`${decoded.createdAt}::timestamptz`
      : sql`${decoded.createdAt.replace(/Z$/, '')}::timestamp`;
    const colMs = sql`date_trunc('milliseconds', ${createdAtColumn})`;
    return or(
      lt(colMs, cursorTs),
      and(eq(colMs, cursorTs), lt(idColumn, decoded.id)),
    );
  }

  /**
   * Fetch one page + a lookahead row. If the lookahead exists there's another
   * page, and its cursor is the last kept row. Keeps the has-more logic in one
   * place so every feed paginates identically.
   */
  private paginate<T extends CursorRow>(rows: T[]): {
    items: T[];
    nextCursor: string | null;
  } {
    if (rows.length <= PAGE_SIZE) return { items: rows, nextCursor: null };
    const items = rows.slice(0, PAGE_SIZE);
    return { items, nextCursor: encodeCursor(items[items.length - 1]) };
  }

  /**
   * Recent posts across all workspaces. The status breakdown counts the whole
   * table and is returned only on the first page (no cursor) — it's the shape of
   * the feed, not of the page, so paying for it on every scroll is waste.
   */
  async getRecentPosts(cursor?: string) {
    const rows = await this.db
      .select({
        id: posts.id,
        workspaceId: posts.workspaceId,
        workspaceName: workspaceNameFor(posts.workspaceId),
        content: posts.content,
        status: posts.status,
        // The per-destination fan-out. We surface only the platform of each
        // target for the feed — enough to show where a post went without
        // shipping tokens/urls/overrides that live in the same jsonb.
        targets: posts.targets,
        scheduledAt: posts.scheduledAt,
        publishedAt: posts.publishedAt,
        lastError: posts.lastError,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(this.keysetBefore(posts.createdAt, posts.id, cursor, true))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(PAGE_SIZE + 1);

    const page = this.paginate(rows);
    const byStatus = cursor
      ? undefined
      : await this.db
          .select({ status: posts.status, count: sql<number>`count(*)::int` })
          .from(posts)
          .groupBy(posts.status);

    return { ...page, byStatus };
  }

  /** Recent campaigns across all workspaces, with a first-page count by status. */
  async getRecentCampaigns(cursor?: string) {
    const rows = await this.db
      .select({
        id: campaigns.id,
        workspaceId: campaigns.workspaceId,
        workspaceName: workspaceNameFor(campaigns.workspaceId),
        name: campaigns.name,
        type: campaigns.type,
        status: campaigns.status,
        platforms: campaigns.platforms,
        launchedAt: campaigns.launchedAt,
        createdAt: campaigns.createdAt,
      })
      .from(campaigns)
      .where(this.keysetBefore(campaigns.createdAt, campaigns.id, cursor, false))
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(PAGE_SIZE + 1);

    const page = this.paginate(rows);
    const byStatus = cursor
      ? undefined
      : await this.db
          .select({
            status: campaigns.status,
            count: sql<number>`count(*)::int`,
          })
          .from(campaigns)
          .groupBy(campaigns.status);

    return { ...page, byStatus };
  }

  /**
   * Recent inbox items across all workspaces — the comments, mentions and DMs
   * that have arrived, newest first. `fromMe` is included so the UI can tell an
   * incoming message from one of our own replies.
   */
  async getRecentInbox(cursor?: string) {
    const rows = await this.db
      .select({
        id: inboxItems.id,
        workspaceId: inboxItems.workspaceId,
        workspaceName: workspaceNameFor(inboxItems.workspaceId),
        platform: inboxItems.platform,
        type: inboxItems.type,
        authorDisplayName: inboxItems.authorDisplayName,
        authorHandle: inboxItems.authorHandle,
        text: inboxItems.text,
        fromMe: inboxItems.fromMe,
        status: inboxItems.status,
        createdAt: inboxItems.createdAt,
      })
      .from(inboxItems)
      .where(this.keysetBefore(inboxItems.createdAt, inboxItems.id, cursor, false))
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(PAGE_SIZE + 1);

    const page = this.paginate(rows);
    const byType = cursor
      ? undefined
      : await this.db
          .select({ type: inboxItems.type, count: sql<number>`count(*)::int` })
          .from(inboxItems)
          .groupBy(inboxItems.type);

    return { ...page, byType };
  }

  /**
   * Recent media uploads across all workspaces. Soft-deleted items are excluded
   * — a deleted upload isn't activity anyone wants to see in a live feed.
   */
  async getRecentMedia(cursor?: string) {
    const keyset = this.keysetBefore(
      mediaItems.createdAt,
      mediaItems.id,
      cursor,
      true,
    );
    const rows = await this.db
      .select({
        id: mediaItems.id,
        workspaceId: mediaItems.workspaceId,
        workspaceName: workspaceNameFor(mediaItems.workspaceId),
        name: mediaItems.name,
        type: mediaItems.type,
        mimeType: mediaItems.mimeType,
        fileSize: mediaItems.fileSize,
        thumbnailUrl: mediaItems.thumbnailUrl,
        createdAt: mediaItems.createdAt,
      })
      .from(mediaItems)
      .where(
        keyset
          ? and(eq(mediaItems.isDeleted, false), keyset)
          : eq(mediaItems.isDeleted, false),
      )
      .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
      .limit(PAGE_SIZE + 1);

    return this.paginate(rows);
  }

  /**
   * Recent ad campaigns across all workspaces — real Meta campaigns created
   * through Boost. This reads only our own stored rows; it makes no call to
   * Meta, so it shows what was created here, not live spend or delivery (which
   * this backend doesn't store).
   */
  async getRecentAds(cursor?: string) {
    const rows = await this.db
      .select({
        id: adCampaigns.id,
        workspaceId: adCampaigns.workspaceId,
        workspaceName: workspaceNameFor(adCampaigns.workspaceId),
        name: adCampaigns.name,
        metaCampaignId: adCampaigns.metaCampaignId,
        createdAt: adCampaigns.createdAt,
      })
      .from(adCampaigns)
      .where(this.keysetBefore(adCampaigns.createdAt, adCampaigns.id, cursor, false))
      .orderBy(desc(adCampaigns.createdAt), desc(adCampaigns.id))
      .limit(PAGE_SIZE + 1);

    return this.paginate(rows);
  }
}
