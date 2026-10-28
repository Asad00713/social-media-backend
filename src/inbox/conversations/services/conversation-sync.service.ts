import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  applyLifecycle,
  type ConversationStatus,
  type DoneVia,
  type LifecycleState,
  type SyncIntent,
  type ThreadFacts,
} from '../lib/lifecycle';
import { replyWindowClosesAt } from '../lib/reply-window';
import { kindOfItem, type ConversationKind } from '../lib/thread-key';
import { InboxRealtimeService } from './inbox-realtime.service';

type Tx = Parameters<Parameters<DbType['transaction']>[0]>[0];

export interface SyncResult {
  conversationId: string | null;
  created: boolean;
  removed: boolean;
  markedDone: boolean;
  reopened: boolean;
  status: ConversationStatus | null;
}

type Ts = Date | string | null;

type FactsRow = {
  item_count: number;
  last_message_at: Ts;
  last_inbound_at: Ts;
  last_outbound_at: Ts;
  last_platform_outbound_at: Ts;
  unread_count: number;
  unanswered_inbound: number;
  open_legacy_inbound: number;
  all_archived: boolean | null;
  max_archived_at: Ts;
  post_id: string | null;
  latest_text: string | null;
  latest_from_me: boolean | null;
  latest_author_name: string | null;
  latest_author_handle: string | null;
  latest_platform: string | null;
  latest_channel_id: number | null;
  latest_type: string | null;
  latest_platform_post_id: string | null;
  snapshot_caption: string | null;
  snapshot_thumbnail: string | null;
  inbound_handle: string | null;
  inbound_name: string | null;
  inbound_avatar: string | null;
  inbound_platform_id: string | null;
};

type PrevRow = {
  id: string;
  status: ConversationStatus;
  later_until: Ts;
  later_until_reply: boolean;
  done_by_user_id: string | null;
  done_at: Ts;
  done_via: DoneVia | null;
  assignee_user_id: string | null;
  assigned_by_user_id: string | null;
  assigned_at: Ts;
  last_inbound_at: Ts;
  last_outbound_at: Ts;
};

const toDate = (v: Ts): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);

const lockOf = (workspaceId: string, threadKey: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || '|' || ${threadKey}::text, 0))`;

/**
 * The single write path for inbox_conversations: derives every column from the
 * thread's inbox_items, applies the lifecycle rules and upserts, all under a
 * per-thread advisory lock.
 */
@Injectable()
export class ConversationSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly realtime: InboxRealtimeService,
  ) {}

  async syncThread(
    workspaceId: string,
    threadKey: string,
    intent: SyncIntent = { kind: 'refresh' },
    now: Date = new Date(),
  ): Promise<SyncResult> {
    const outcome = await this.db.transaction((tx) =>
      this.syncInTx(tx, workspaceId, threadKey, intent, now),
    );
    if (outcome.removedId !== null) {
      this.realtime.conversationRemoved(workspaceId, outcome.removedId);
      this.realtime.countsChanged(workspaceId);
    } else if (outcome.result.conversationId !== null) {
      this.realtime.conversationChanged(
        workspaceId,
        outcome.result.conversationId,
      );
      this.realtime.countsChanged(workspaceId);
    }
    return outcome.result;
  }

  /** De-duplicated, sequential. */
  async syncThreads(
    workspaceId: string,
    threadKeys: Iterable<string>,
    intent?: SyncIntent,
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const key of new Set(threadKeys)) {
      results.push(await this.syncThread(workspaceId, key, intent));
    }
    return results;
  }

  /**
   * R3: an item changed thread (a mention turned out to be a comment on a post
   * we know). Moves the old conversation's notes and scheduled replies to the
   * new one, then refreshes both.
   */
  async rekey(
    workspaceId: string,
    fromKey: string,
    toKey: string,
  ): Promise<void> {
    if (fromKey === toKey) return;
    // D1: the moved item already carries toKey, so this creates the target.
    // It must run BEFORE the transaction below: syncThread opens its own.
    await this.syncThread(workspaceId, toKey);

    await this.db.transaction(async (tx) => {
      for (const key of [fromKey, toKey].sort()) {
        await tx.execute(lockOf(workspaceId, key));
      }
      const ids = await tx.execute<{ id: string; thread_key: string }>(sql`
        SELECT id, thread_key FROM inbox_conversations
         WHERE workspace_id = ${workspaceId}::uuid
           AND thread_key IN (${fromKey}, ${toKey})
         FOR UPDATE
      `);
      const from = ids.rows.find((r) => r.thread_key === fromKey);
      const to = ids.rows.find((r) => r.thread_key === toKey);
      if (!from || !to) return;
      await tx.execute(sql`
        UPDATE inbox_notes SET conversation_id = ${to.id}::uuid
         WHERE conversation_id = ${from.id}::uuid
      `);
      await tx.execute(sql`
        UPDATE scheduled_inbox_messages
           SET inbox_conversation_id = ${to.id}::uuid,
               thread_key = ${toKey}
         WHERE inbox_conversation_id = ${from.id}::uuid
      `);
    });

    await this.syncThread(workspaceId, fromKey);
    await this.syncThread(workspaceId, toKey);
  }

  private async syncInTx(
    tx: Tx,
    workspaceId: string,
    threadKey: string,
    intent: SyncIntent,
    now: Date,
  ): Promise<{ result: SyncResult; removedId: string | null }> {
    // 1. Serialise every sync of this thread, including the first insert.
    await tx.execute(lockOf(workspaceId, threadKey));

    // 2. Facts, in one aggregate plus three "latest row" subselects.
    const factsRes = await tx.execute<FactsRow>(sql`
      WITH agg AS (
        SELECT count(*)::int AS item_count,
               date_trunc('milliseconds', max(platform_created_at)) AS last_message_at,
               date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE NOT from_me)) AS last_inbound_at,
               date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE from_me)) AS last_outbound_at,
               date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE from_me AND authored_by_user_id IS NULL)) AS last_platform_outbound_at,
               (count(*) FILTER (WHERE NOT from_me AND status = 'unread'))::int AS unread_count,
               (count(*) FILTER (WHERE NOT from_me AND replied_at IS NULL
                                   AND metadata->>'deletedAt' IS NULL
                                   AND NOT is_hidden))::int AS unanswered_inbound,
               (count(*) FILTER (WHERE NOT from_me
                                   AND status IN ('unread', 'needs_reply')))::int AS open_legacy_inbound,
               bool_and(archived_at IS NOT NULL) AS all_archived,
               max(archived_at) AS max_archived_at,
               max(our_post_id::text)::uuid AS post_id
          FROM inbox_items
         WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
      ),
      latest AS (
        SELECT text AS latest_text, from_me AS latest_from_me,
               author_display_name AS latest_author_name,
               author_handle AS latest_author_handle,
               platform AS latest_platform, channel_id AS latest_channel_id,
               type AS latest_type, platform_post_id AS latest_platform_post_id
          FROM inbox_items
         WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
         ORDER BY platform_created_at DESC, id DESC
         LIMIT 1
      ),
      snap AS (
        SELECT metadata->'post'->>'caption' AS snapshot_caption,
               metadata->'post'->>'thumbnailUrl' AS snapshot_thumbnail
          FROM inbox_items
         WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
           AND jsonb_typeof(metadata->'post') = 'object'
           AND metadata->'post' <> '{}'::jsonb
         ORDER BY platform_created_at DESC, id DESC
         LIMIT 1
      ),
      inb AS (
        SELECT author_handle AS inbound_handle,
               author_display_name AS inbound_name,
               author_avatar_url AS inbound_avatar,
               author_platform_id AS inbound_platform_id
          FROM inbox_items
         WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
           AND NOT from_me
         ORDER BY platform_created_at DESC, id DESC
         LIMIT 1
      )
      SELECT agg.*, latest.*, snap.*, inb.*
        FROM agg
        LEFT JOIN latest ON true
        LEFT JOIN snap ON true
        LEFT JOIN inb ON true
    `);
    const f = factsRes.rows[0];

    // 3. Nothing left: drop the conversation.
    if (!f || Number(f.item_count) === 0) {
      const del = await tx.execute<{ id: string }>(sql`
        DELETE FROM inbox_conversations
         WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
        RETURNING id
      `);
      const removedId = del.rows[0]?.id ?? null;
      return {
        removedId,
        result: {
          conversationId: removedId,
          created: false,
          removed: removedId !== null,
          markedDone: false,
          reopened: false,
          status: null,
        },
      };
    }

    // 4. Derived columns.
    const lastInboundAt = toDate(f.last_inbound_at);
    const lastOutboundAt = toDate(f.last_outbound_at);
    const platform = f.latest_platform!;
    const kind: ConversationKind = kindOfItem({
      type: f.latest_type!,
      platformPostId: f.latest_platform_post_id,
    });
    const participantName = kind === 'comment_thread' ? null : f.inbound_name;
    const participantHandle =
      kind === 'comment_thread' ? null : f.inbound_handle;
    const title =
      kind === 'comment_thread'
        ? f.snapshot_caption
        : (participantName ?? participantHandle);
    const closesAt = replyWindowClosesAt(platform, kind, lastInboundAt);
    const archivedAt = f.all_archived ? toDate(f.max_archived_at) : null;

    const facts: ThreadFacts = {
      kind,
      lastInboundAt,
      lastOutboundAt,
      lastPlatformOutboundAt: toDate(f.last_platform_outbound_at),
      unansweredInbound: Number(f.unanswered_inbound),
      openLegacyInbound: Number(f.open_legacy_inbound),
    };

    // 5. Lifecycle against the stored row, then the upsert.
    const prevRes = await tx.execute<PrevRow>(sql`
      SELECT id, status, later_until, later_until_reply, done_by_user_id,
             done_at, done_via, assignee_user_id, assigned_by_user_id,
             assigned_at, last_inbound_at, last_outbound_at
        FROM inbox_conversations
       WHERE workspace_id = ${workspaceId}::uuid AND thread_key = ${threadKey}
       FOR UPDATE
    `);
    const p = prevRes.rows[0];
    const prev: LifecycleState | null = p
      ? {
          status: p.status,
          laterUntil: toDate(p.later_until),
          laterUntilReply: p.later_until_reply,
          doneByUserId: p.done_by_user_id,
          doneAt: toDate(p.done_at),
          doneVia: p.done_via,
          assigneeUserId: p.assignee_user_id,
          assignedByUserId: p.assigned_by_user_id,
          assignedAt: toDate(p.assigned_at),
          lastInboundAt: toDate(p.last_inbound_at),
          lastOutboundAt: toDate(p.last_outbound_at),
        }
      : null;
    const { next, markedDone, reopened } = applyLifecycle(
      prev,
      facts,
      intent,
      now,
    );

    const lastSnippet = f.latest_text;
    const lastAuthorLabel = f.latest_author_name ?? f.latest_author_handle;
    const isPersonThread = kind !== 'comment_thread';
    const participantAvatar = isPersonThread ? f.inbound_avatar : null;
    const participantPlatformId = isPersonThread ? f.inbound_platform_id : null;

    const up = await tx.execute<{ id: string; inserted: boolean }>(sql`
      INSERT INTO inbox_conversations (
        workspace_id, channel_id, platform, kind, thread_key, status,
        later_until, later_until_reply, assignee_user_id, assigned_by_user_id,
        done_by_user_id, assigned_at, done_at, done_via, unread_count,
        item_count, last_message_at, last_inbound_at, last_outbound_at,
        last_snippet, last_author_label, last_from_me, reply_window_closes_at,
        post_id, title, thumbnail_url, participant_handle, participant_name,
        participant_avatar_url, participant_platform_id, search_text,
        archived_at
      ) VALUES (
        ${workspaceId}::uuid, ${f.latest_channel_id}::int, ${platform}, ${kind},
        ${threadKey}, ${next.status}, ${next.laterUntil}::timestamptz,
        ${next.laterUntilReply}, ${next.assigneeUserId}::uuid,
        ${next.assignedByUserId}::uuid, ${next.doneByUserId}::uuid,
        ${next.assignedAt}::timestamptz, ${next.doneAt}::timestamptz,
        ${next.doneVia}, ${Number(f.unread_count)}::int,
        ${Number(f.item_count)}::int, ${toDate(f.last_message_at)}::timestamptz,
        ${lastInboundAt}::timestamptz, ${lastOutboundAt}::timestamptz,
        ${lastSnippet}::text, ${lastAuthorLabel}::text,
        ${f.latest_from_me ?? false}, ${closesAt}::timestamptz,
        ${f.post_id}::uuid, ${title}::text, ${f.snapshot_thumbnail}::text,
        ${participantHandle}::text, ${participantName}::text,
        ${participantAvatar}::text, ${participantPlatformId}::text,
        lower(concat_ws(' ', ${title}::text, ${participantName}::text,
                        ${participantHandle}::text, ${lastSnippet}::text)),
        ${archivedAt}::timestamptz
      )
      ON CONFLICT (workspace_id, thread_key) DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        platform = EXCLUDED.platform,
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        later_until = EXCLUDED.later_until,
        later_until_reply = EXCLUDED.later_until_reply,
        assignee_user_id = EXCLUDED.assignee_user_id,
        assigned_by_user_id = EXCLUDED.assigned_by_user_id,
        done_by_user_id = EXCLUDED.done_by_user_id,
        assigned_at = EXCLUDED.assigned_at,
        done_at = EXCLUDED.done_at,
        done_via = EXCLUDED.done_via,
        unread_count = EXCLUDED.unread_count,
        item_count = EXCLUDED.item_count,
        last_message_at = EXCLUDED.last_message_at,
        last_inbound_at = EXCLUDED.last_inbound_at,
        last_outbound_at = EXCLUDED.last_outbound_at,
        last_snippet = EXCLUDED.last_snippet,
        last_author_label = EXCLUDED.last_author_label,
        last_from_me = EXCLUDED.last_from_me,
        reply_window_closes_at = EXCLUDED.reply_window_closes_at,
        post_id = EXCLUDED.post_id,
        title = EXCLUDED.title,
        thumbnail_url = EXCLUDED.thumbnail_url,
        participant_handle = EXCLUDED.participant_handle,
        participant_name = EXCLUDED.participant_name,
        participant_avatar_url = EXCLUDED.participant_avatar_url,
        participant_platform_id = EXCLUDED.participant_platform_id,
        search_text = EXCLUDED.search_text,
        archived_at = EXCLUDED.archived_at,
        updated_at = now()
      RETURNING id, (xmax = 0) AS inserted
    `);
    const row = up.rows[0];
    return {
      removedId: null,
      result: {
        conversationId: row.id,
        created: row.inserted,
        removed: false,
        markedDone,
        reopened,
        status: next.status,
      },
    };
  }
}
