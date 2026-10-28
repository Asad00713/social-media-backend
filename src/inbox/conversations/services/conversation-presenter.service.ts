import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  localDateOf,
  safeTimeZone,
  wallClockToUtc,
} from '../../../planner/lib/workspace-time';
import type { ConversationRow, InboxCounts, UserRef } from '../dto/contract';
import { presentRow, type ConversationRecord } from '../lib/present-row';
import type { ConversationKind } from '../lib/thread-key';
import type { ConversationStatus, DoneVia } from '../lib/lifecycle';

/** One result row of the conversation query, column names as selected. */
type RawRow = {
  id: string;
  kind: ConversationKind;
  thread_key: string;
  channel_id: number;
  platform: string;
  status: ConversationStatus;
  title: string | null;
  participant_name: string | null;
  participant_handle: string | null;
  participant_avatar_url: string | null;
  thumbnail_url: string | null;
  last_author_label: string | null;
  last_snippet: string | null;
  last_from_me: boolean;
  unread_count: number;
  last_message_at: Date | string;
  assigned_at: Date | string | null;
  later_until: Date | string | null;
  later_until_reply: boolean;
  done_at: Date | string | null;
  done_via: DoneVia | null;
  reply_window_closes_at: Date | string | null;
  channel_username: string | null;
  channel_account_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  assigner_id: string | null;
  assigner_name: string | null;
  assigner_avatar: string | null;
  doner_id: string | null;
  doner_name: string | null;
  doner_avatar: string | null;
  sched_id: string | null;
  sched_at: Date | string | null;
  sched_status: 'pending' | 'failed' | null;
  sched_by_id: string | null;
  sched_by_name: string | null;
  sched_by_avatar: string | null;
};

const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const dateOrNull = (v: Date | string | null): Date | null =>
  v === null ? null : date(v);

function userRef(
  id: string | null,
  name: string | null,
  avatar: string | null,
): UserRef | null {
  return id === null ? null : { id, name: name ?? '', avatarUrl: avatar };
}

function toRecord(r: RawRow): ConversationRecord {
  return {
    id: r.id,
    kind: r.kind,
    threadKey: r.thread_key,
    channelId: Number(r.channel_id),
    platform: r.platform,
    status: r.status,
    title: r.title,
    participantName: r.participant_name,
    participantHandle: r.participant_handle,
    participantAvatarUrl: r.participant_avatar_url,
    thumbnailUrl: r.thumbnail_url,
    lastAuthorLabel: r.last_author_label,
    lastSnippet: r.last_snippet,
    lastFromMe: r.last_from_me,
    unreadCount: r.unread_count,
    lastMessageAt: date(r.last_message_at),
    assignedAt: dateOrNull(r.assigned_at),
    laterUntil: dateOrNull(r.later_until),
    laterUntilReply: r.later_until_reply,
    doneAt: dateOrNull(r.done_at),
    doneVia: r.done_via,
    replyWindowClosesAt: dateOrNull(r.reply_window_closes_at),
    channelUsername: r.channel_username,
    channelAccountName: r.channel_account_name,
    assignee: userRef(r.assignee_id, r.assignee_name, r.assignee_avatar),
    assignedBy: userRef(r.assigner_id, r.assigner_name, r.assigner_avatar),
    doneBy: userRef(r.doner_id, r.doner_name, r.doner_avatar),
    scheduled:
      r.sched_id !== null && r.sched_at !== null && r.sched_status !== null
        ? {
            id: r.sched_id,
            sendAt: date(r.sched_at),
            by: userRef(r.sched_by_id, r.sched_by_name, r.sched_by_avatar),
            status: r.sched_status,
          }
        : null,
  };
}

/** Loads conversation rows in the contract's shape, and the inbox counts. */
@Injectable()
export class ConversationPresenter {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * ONE query. Rows come back in the order of `ids`; ids of another workspace
   * are dropped. Archived rows are included (D7): the list service filters
   * them itself.
   */
  async loadRows(
    workspaceId: string,
    ids: string[],
    now: Date = new Date(),
  ): Promise<ConversationRow[]> {
    if (ids.length === 0) return [];
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const records = await this.select(
      sql`c.workspace_id = ${workspaceId}::uuid AND c.id IN (${idList})`,
    );
    const byId = new Map(records.map((r) => [r.id, r]));
    const out: ConversationRow[] = [];
    for (const id of new Set(ids)) {
      const rec = byId.get(id);
      if (rec) out.push(presentRow(rec, now));
    }
    return out;
  }

  async loadRowByThreadKey(
    workspaceId: string,
    threadKey: string,
    now: Date = new Date(),
  ): Promise<ConversationRow | null> {
    const records = await this.select(
      sql`c.workspace_id = ${workspaceId}::uuid AND c.thread_key = ${threadKey}`,
    );
    return records.length ? presentRow(records[0], now) : null;
  }

  /** Two queries: the three status counts plus the zone, then replies today. */
  async counts(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<InboxCounts> {
    const head = await this.db.execute<{
      to_reply: number;
      later: number;
      scheduled: number;
      timezone: string | null;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE c.status = 'to_reply')::int AS to_reply,
        count(*) FILTER (WHERE c.status = 'later')::int AS later,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM scheduled_inbox_messages s
           WHERE s.inbox_conversation_id = c.id
             AND s.status IN ('pending', 'failed')
        ))::int AS scheduled,
        (SELECT w.timezone FROM workspace w WHERE w.id = ${workspaceId}::uuid)
          AS timezone
      FROM inbox_conversations c
      WHERE c.workspace_id = ${workspaceId}::uuid AND c.archived_at IS NULL
    `);
    const h = head.rows[0];
    const zone = safeTimeZone(h?.timezone ?? 'UTC');
    const startOfToday = wallClockToUtc(localDateOf(now, zone), '00:00', zone);

    const answered = await this.db.execute<{
      total: number;
      id: string;
      name: string | null;
      avatar_url: string | null;
      replies: number;
    }>(sql`
      WITH r AS (
        SELECT i.authored_by_user_id AS uid, i.thread_key
          FROM inbox_items i
         WHERE i.workspace_id = ${workspaceId}::uuid
           AND i.from_me
           AND i.authored_by_user_id IS NOT NULL
           AND i.platform_created_at >= ${startOfToday}
      )
      SELECT (SELECT count(DISTINCT thread_key) FROM r)::int AS total,
             u.id, u.name, u.avatar_url, count(*)::int AS replies
        FROM r JOIN users u ON u.id = r.uid
       GROUP BY u.id, u.name, u.avatar_url
       ORDER BY replies DESC, u.name ASC, u.id ASC
    `);
    const by = answered.rows.map((a) => ({
      id: a.id,
      name: a.name ?? '',
      avatarUrl: a.avatar_url,
    }));
    return {
      toReply: Number(h?.to_reply ?? 0),
      later: Number(h?.later ?? 0),
      scheduled: Number(h?.scheduled ?? 0),
      answeredToday: {
        total: answered.rows.length ? Number(answered.rows[0].total) : 0,
        by,
      },
    };
  }

  private async select(where: SQL): Promise<ConversationRecord[]> {
    const res = await this.db.execute<RawRow>(sql`
      SELECT c.id, c.kind, c.thread_key, c.channel_id, c.platform, c.status,
             c.title, c.participant_name, c.participant_handle,
             c.participant_avatar_url, c.thumbnail_url, c.last_author_label,
             c.last_snippet, c.last_from_me, c.unread_count, c.last_message_at,
             c.assigned_at, c.later_until, c.later_until_reply, c.done_at,
             c.done_via, c.reply_window_closes_at,
             ch.username AS channel_username,
             ch.account_name AS channel_account_name,
             ua.id AS assignee_id, ua.name AS assignee_name,
             ua.avatar_url AS assignee_avatar,
             ub.id AS assigner_id, ub.name AS assigner_name,
             ub.avatar_url AS assigner_avatar,
             ud.id AS doner_id, ud.name AS doner_name,
             ud.avatar_url AS doner_avatar,
             s.id AS sched_id, s.scheduled_at AS sched_at,
             s.status AS sched_status,
             us.id AS sched_by_id, us.name AS sched_by_name,
             us.avatar_url AS sched_by_avatar
        FROM inbox_conversations c
        JOIN social_media_channels ch ON ch.id = c.channel_id
        LEFT JOIN users ua ON ua.id = c.assignee_user_id
        LEFT JOIN users ub ON ub.id = c.assigned_by_user_id
        LEFT JOIN users ud ON ud.id = c.done_by_user_id
        LEFT JOIN LATERAL (
          SELECT m.id, m.scheduled_at, m.status, m.created_by_user_id
            FROM scheduled_inbox_messages m
           WHERE m.inbox_conversation_id = c.id
             AND m.status IN ('pending', 'failed')
           ORDER BY (m.status = 'failed') DESC, m.scheduled_at ASC
           LIMIT 1
        ) s ON true
        LEFT JOIN users us ON us.id = s.created_by_user_id
       WHERE ${where}
    `);
    return res.rows.map(toRecord);
  }
}
