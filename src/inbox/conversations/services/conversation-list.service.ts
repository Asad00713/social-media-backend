import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { buildSearchPattern, isSearchable } from '../../inbox.service';
import type {
  InboxSort,
  InboxType,
  InboxView,
  ListConversationsResponse,
} from '../dto/contract';
import type { ListConversationsQueryDto } from '../dto/list-conversations.query';
import {
  decodeConversationCursor,
  encodeConversationCursor,
  type ConversationCursor,
} from '../lib/list-cursor';
import { ConversationPresenter } from './conversation-presenter.service';

const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_OF_TYPE: Record<Exclude<InboxType, 'all'>, string> = {
  message: 'dm',
  comment: 'comment_thread',
  mention: 'mention',
};

/**
 * Timestamps leave SQL as text with microseconds and come back as a typed
 * parameter, so no JS Date (milliseconds) ever sits on the cursor path.
 */
const iso = (col: SQL) =>
  sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Lists conversations (never items) with keyset paging, search and filters. */
@Injectable()
export class ConversationListService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly presenter: ConversationPresenter,
  ) {}

  async list(
    workspaceId: string,
    userId: string,
    q: ListConversationsQueryDto,
    now: Date = new Date(),
  ): Promise<ListConversationsResponse> {
    const view: InboxView = q.view ?? 'to_reply';
    const type: InboxType = q.type ?? 'all';
    const sortParam: InboxSort = q.sort ?? 'newest';
    const limit = q.limit ?? 30;
    const search = isSearchable(q.q);
    const bySendTime = view === 'scheduled' && !search;
    const sort: InboxSort | 'send' = bySendTime ? 'send' : sortParam;

    const where: SQL[] = [
      sql`c.workspace_id = ${workspaceId}::uuid`,
      sql`c.archived_at IS NULL`,
    ];

    if (search) {
      const pattern = buildSearchPattern((q.q as string).trim());
      where.push(sql`(c.search_text ILIKE ${pattern} OR c.thread_key IN (
        SELECT i.thread_key FROM inbox_items i
         WHERE i.workspace_id = ${workspaceId}::uuid
           AND (coalesce(i.text, '') || ' ' || coalesce(i.author_handle, '')
                || ' ' || coalesce(i.author_display_name, '')) ILIKE ${pattern}
      ))`);
    } else if (view === 'done') {
      where.push(
        sql`c.status = 'done'`,
        sql`c.done_at >= ${new Date(now.getTime() - DONE_WINDOW_MS)}`,
      );
    } else if (view === 'scheduled') {
      where.push(sql`n.next_send_at IS NOT NULL`);
    } else {
      where.push(sql`c.status = ${view}`);
    }

    if (type !== 'all') where.push(sql`c.kind = ${KIND_OF_TYPE[type]}`);
    if (q.channelIds?.length) {
      where.push(
        sql`c.channel_id IN (${sql.join(
          q.channelIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    if (q.assigned === 'me')
      where.push(sql`c.assignee_user_id = ${userId}::uuid`);
    if (q.assigned === 'unassigned')
      where.push(sql`c.assignee_user_id IS NULL`);
    if (q.unread === true) where.push(sql`c.unread_count > 0`);

    // The sort key as a timestamptz expression, and the same key as text.
    let keyExpr: SQL;
    let keyText: SQL;
    if (sort === 'send') {
      keyExpr = sql`n.next_send_at`;
      keyText = iso(keyExpr);
    } else if (sort === 'window') {
      keyExpr = sql`COALESCE(c.reply_window_closes_at, 'infinity'::timestamptz)`;
      keyText = sql`CASE WHEN c.reply_window_closes_at IS NULL THEN 'inf'
        ELSE ${iso(sql`c.reply_window_closes_at`)} END`;
    } else {
      keyExpr = sql`c.last_message_at`;
      keyText = iso(keyExpr);
    }
    const asc = sort !== 'newest';
    const dir = asc ? sql`ASC` : sql`DESC`;
    const cmp = asc ? sql`>` : sql`<`;

    // `n` is joined exactly when the scheduled filter / send-time order use it.
    const from = sql`FROM inbox_conversations c ${
      sort === 'send'
        ? sql`LEFT JOIN LATERAL (
            SELECT min(m.scheduled_at) AS next_send_at
              FROM scheduled_inbox_messages m
             WHERE m.inbox_conversation_id = c.id
               AND m.status IN ('pending', 'failed')
          ) n ON true`
        : sql``
    }`;

    const cursorView: ConversationCursor['v'] = search ? 'search' : view;
    const page = [...where];
    if (q.cursor) {
      const cur = decodeConversationCursor(q.cursor, cursorView, sort);
      const kParam = cur.k === 'inf' ? 'infinity' : cur.k;
      page.push(
        sql`(${keyExpr}, c.id) ${cmp} (${kParam}::timestamptz, ${cur.id}::uuid)`,
      );
    }

    const pageRes = await this.db.execute<{ id: string; k: string }>(sql`
      SELECT c.id, ${keyText} AS k
        ${from}
       WHERE ${sql.join(page, sql` AND `)}
       ORDER BY ${keyExpr} ${dir}, c.id ${dir}
       LIMIT ${limit + 1}
    `);
    const found = pageRes.rows;
    const rowsOnPage = found.slice(0, limit);
    const last = rowsOnPage[rowsOnPage.length - 1];
    const nextCursor =
      found.length > limit && last
        ? encodeConversationCursor({
            v: cursorView,
            s: sort,
            k: last.k,
            id: last.id,
          })
        : null;

    const totalRes = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total ${from}
       WHERE ${sql.join(where, sql` AND `)}
    `);

    return {
      rows: await this.presenter.loadRows(
        workspaceId,
        rowsOnPage.map((r) => r.id),
        now,
      ),
      nextCursor,
      total: Number(totalRes.rows[0]?.total ?? 0),
    };
  }
}
