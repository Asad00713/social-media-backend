import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  lte,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  insightReports,
  type NewInsightReportRow,
} from '../../drizzle/schema/insight-reports.schema';
import { mediaItems } from '../../drizzle/schema/media-library.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { safeTimeZone } from '../../planner/lib/workspace-time';
import type { ReportRecord } from './lib/report-dto';
import type { ReportPerson } from './reports.dto';

type NamedUser = { name: SQLWrapper; email: SQLWrapper };

/**
 * `media_items.is_deleted` is nullable, so "binned" is `coalesce(.., false)`:
 * a null row is a live one, never a binned one.
 */
const logoIsBinned = sql<boolean>`coalesce(${mediaItems.isDeleted}, false)`;

/**
 * THE rule for "the logo media item is live": it belongs to the report's
 * workspace and is not in the recycle bin (a binned item is purged after 30
 * days, file included, so it reads as no logo). Used by the left join behind
 * `ReportRecord.logoUrl` and by `logoUrl()`; nowhere else restates it.
 */
function liveLogoOf(workspaceId: SQLWrapper | string): SQL {
  return and(
    eq(mediaItems.workspaceId, workspaceId),
    sql`not ${logoIsBinned}`,
  ) as SQL;
}

/** A person's name: their name, or the part of their email before the @. */
function personName(u: NamedUser): SQL<string | null> {
  return sql<
    string | null
  >`coalesce(nullif(${u.name}, ''), split_part(${u.email}, '@', 1))`;
}

function person(id: string | null, name: string | null): ReportPerson | null {
  return id && name != null ? { id, name } : null;
}

/**
 * The DB access for saved Insights reports. Reads that take a workspace id are
 * scoped to it; `getById`, `byShareToken`, `due`, `optOut` and the `record*`
 * writes are for the public routes and the send job, which hold no workspace.
 * `update` writes exactly the columns it is given: whether a write counts as a
 * person's edit (`updated_at`, `updated_by`) is the caller's decision, and
 * `optOut`, `recordSent` and `recordError` never count.
 */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** A report row with its live logo URL and the people who made and edited it. */
  private records() {
    const createdByUser = alias(users, 'created_by_user');
    const updatedByUser = alias(users, 'updated_by_user');
    const select = this.db
      .select({
        row: insightReports,
        logoUrl: mediaItems.fileUrl,
        createdById: createdByUser.id,
        createdName: personName(createdByUser),
        updatedById: updatedByUser.id,
        updatedName: personName(updatedByUser),
      })
      .from(insightReports)
      .leftJoin(
        mediaItems,
        and(
          eq(mediaItems.id, insightReports.logoMediaId),
          liveLogoOf(insightReports.workspaceId),
        ),
      )
      .leftJoin(createdByUser, eq(createdByUser.id, insightReports.createdBy))
      .leftJoin(updatedByUser, eq(updatedByUser.id, insightReports.updatedBy));
    const toRecord = (r: Awaited<typeof select>[number]): ReportRecord => ({
      row: r.row,
      logoUrl: r.logoUrl,
      createdBy: person(r.createdById, r.createdName),
      updatedBy: person(r.updatedById, r.updatedName),
    });
    return { select, toRecord };
  }

  /** The workspace's reports, newest first. */
  async list(workspaceId: string): Promise<ReportRecord[]> {
    const { select, toRecord } = this.records();
    const rows = await select
      .where(eq(insightReports.workspaceId, workspaceId))
      .orderBy(desc(insightReports.createdAt), desc(insightReports.id));
    return rows.map(toRecord);
  }

  async get(workspaceId: string, id: string): Promise<ReportRecord | null> {
    const { select, toRecord } = this.records();
    const [r] = await select
      .where(
        and(
          eq(insightReports.workspaceId, workspaceId),
          eq(insightReports.id, id),
        ),
      )
      .limit(1);
    return r ? toRecord(r) : null;
  }

  /** For the send job, which holds no workspace. */
  async getById(id: string): Promise<ReportRecord | null> {
    const { select, toRecord } = this.records();
    const [r] = await select.where(eq(insightReports.id, id)).limit(1);
    return r ? toRecord(r) : null;
  }

  /** The public lookup. A report whose link is off has a null token, so no match. */
  async byShareToken(token: string): Promise<ReportRecord | null> {
    const { select, toRecord } = this.records();
    const [r] = await select
      .where(eq(insightReports.shareToken, token))
      .limit(1);
    return r ? toRecord(r) : null;
  }

  async insert(values: NewInsightReportRow): Promise<string> {
    const [r] = await this.db
      .insert(insightReports)
      .values(values)
      .returning({ id: insightReports.id });
    return r.id;
  }

  /** False when the report is not in this workspace. */
  async update(
    workspaceId: string,
    id: string,
    patch: Partial<NewInsightReportRow>,
  ): Promise<boolean> {
    const rows = await this.db
      .update(insightReports)
      .set(patch)
      .where(
        and(
          eq(insightReports.workspaceId, workspaceId),
          eq(insightReports.id, id),
        ),
      )
      .returning({ id: insightReports.id });
    return rows.length > 0;
  }

  /** False when the report is not in this workspace. */
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(insightReports)
      .where(
        and(
          eq(insightReports.workspaceId, workspaceId),
          eq(insightReports.id, id),
        ),
      )
      .returning({ id: insightReports.id });
    return rows.length > 0;
  }

  async workspaceInfo(
    workspaceId: string,
  ): Promise<{ name: string; timezone: string; isActive: boolean } | null> {
    const [w] = await this.db
      .select({
        name: workspace.name,
        timezone: workspace.timezone,
        isActive: workspace.isActive,
      })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return w ? { ...w, timezone: safeTimeZone(w.timezone) } : null;
  }

  /**
   * Who "send to the team" reaches: the owner plus every ACCEPTED member, one
   * row per user, owner first. A suspended user is left out, the owner
   * included, so a suspended owner leaves no `isOwner` row and the caller has
   * no reply-to address for the email (it sends without one).
   */
  async team(
    workspaceId: string,
  ): Promise<{ userId: string; email: string; isOwner: boolean }[]> {
    const result = await this.db.execute(sql`
      WITH people AS (
        SELECT w.owner_id AS user_id
        FROM workspace w
        WHERE w.id = ${workspaceId}
        UNION
        SELECT i.user_id
        FROM workspace_invitations i
        WHERE i.workspace_id = ${workspaceId}
          AND i.status = 'ACCEPTED'
          AND i.user_id IS NOT NULL
      )
      SELECT u.id AS "userId", u.email AS "email", (u.id = w.owner_id) AS "isOwner"
      FROM people p
      JOIN users u ON u.id = p.user_id AND u.is_active = true
      JOIN workspace w ON w.id = ${workspaceId}
      ORDER BY "isOwner" DESC, u.email
    `);
    return result.rows as unknown as {
      userId: string;
      email: string;
      isOwner: boolean;
    }[];
  }

  /** The media item's facts, binned or not, so the caller can refuse a bad logo. */
  async logoItem(
    workspaceId: string,
    mediaId: string,
  ): Promise<{
    type: string;
    mimeType: string | null;
    isDeleted: boolean;
  } | null> {
    const [m] = await this.db
      .select({
        type: mediaItems.type,
        mimeType: mediaItems.mimeType,
        isDeleted: logoIsBinned,
      })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.id, mediaId),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return m ?? null;
  }

  /** The logo's public URL; null for no id, a missing item or a binned one. */
  async logoUrl(
    workspaceId: string,
    mediaId: string | null,
  ): Promise<string | null> {
    if (!mediaId) return null;
    const [m] = await this.db
      .select({ url: mediaItems.fileUrl })
      .from(mediaItems)
      .where(and(eq(mediaItems.id, mediaId), liveLogoOf(workspaceId)))
      .limit(1);
    return m?.url ?? null;
  }

  /**
   * The unsubscribe write: adds the lowercased address once (a repeat leaves
   * one entry) and does not touch `updated_at` or `updated_by`. Null when the
   * report is gone.
   */
  async optOut(
    id: string,
    email: string,
  ): Promise<{ reportName: string; workspaceName: string } | null> {
    const address = email.trim().toLowerCase();
    const result = await this.db.execute(sql`
      UPDATE insight_reports r
      SET opted_out = ARRAY(
        SELECT DISTINCT e
        FROM unnest(r.opted_out || ARRAY[${address}]::text[]) AS e
        ORDER BY e
      )
      FROM workspace w
      WHERE r.id = ${id} AND w.id = r.workspace_id
      RETURNING r.name AS "reportName", w.name AS "workspaceName"
    `);
    const [r] = result.rows as unknown as {
      reportName: string;
      workspaceName: string;
    }[];
    return r ?? null;
  }

  /**
   * Scheduled reports whose slot has come, oldest first. A suspended workspace
   * emails nobody; its share links still work.
   */
  async due(
    now: Date,
    limit = 500,
  ): Promise<{ id: string; nextRunAt: Date }[]> {
    const rows = await this.db
      .select({ id: insightReports.id, nextRunAt: insightReports.nextRunAt })
      .from(insightReports)
      .innerJoin(workspace, eq(workspace.id, insightReports.workspaceId))
      .where(
        and(
          isNotNull(insightReports.cadence),
          lte(insightReports.nextRunAt, now),
          eq(workspace.isActive, true),
        ),
      )
      .orderBy(asc(insightReports.nextRunAt), asc(insightReports.id))
      .limit(limit);
    // `lte` on next_run_at excludes null, which the select type cannot see.
    return rows.map((r) => ({ id: r.id, nextRunAt: r.nextRunAt as Date }));
  }

  /**
   * A send went out: stamp it, clear the error and move to the next slot (an
   * undefined `nextRunAt` leaves the slot alone, as a Send now does). Not an
   * edit, so `updated_at` and `updated_by` stay.
   */
  async recordSent(
    id: string,
    sentAt: Date,
    nextRunAt: Date | undefined,
  ): Promise<void> {
    await this.db
      .update(insightReports)
      .set({ lastSentAt: sentAt, lastError: null, nextRunAt })
      .where(eq(insightReports.id, id));
  }

  /** A send failed for good. Same slot rule and the same "not an edit" as `recordSent`. */
  async recordError(
    id: string,
    message: string,
    nextRunAt: Date | undefined,
  ): Promise<void> {
    await this.db
      .update(insightReports)
      .set({ lastError: message, nextRunAt })
      .where(eq(insightReports.id, id));
  }
}
