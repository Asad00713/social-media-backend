import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { loadWorkspaceTimezone } from '../../../planner/lib/workspace-time';
import { roleCan } from '../../../workspace-members/role-capabilities';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';
import type {
  BulkResult,
  ConversationRow,
  MutationResult,
} from '../dto/contract';
import type { BulkConversationsDto } from '../dto/bulk.dto';
import type { PatchConversationDto } from '../dto/patch-conversation.dto';
import { resolveLaterPreset } from '../lib/later-presets';
import type { ConversationStatus, SyncIntent } from '../lib/lifecycle';
import { undoFor, type PatchState } from '../lib/undo';
import { ConversationPresenter } from './conversation-presenter.service';
import { ConversationSyncService } from './conversation-sync.service';
import { InboxNotifyService } from './inbox-notify.service';
import { InboxRealtimeService } from './inbox-realtime.service';
import { LaterWakeService } from './later-wake.service';

type Ts = Date | string | null;

// A type alias, not an interface: db.execute<T> needs an implicit index signature.
type ConversationRef = {
  id: string;
  thread_key: string;
  status: ConversationStatus;
  later_until: Ts;
  later_until_reply: boolean;
  assignee_user_id: string | null;
};

const toDate = (v: Ts): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);

/**
 * User-driven changes to a conversation. Every write goes through
 * ConversationSyncService (one transaction per call). D1: the follow-ups
 * (Later wake job, assignment notification) run only AFTER that commit, never
 * inside a transaction of this service.
 */
@Injectable()
export class ConversationMutationsService {
  private readonly logger = new Logger(ConversationMutationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly sync: ConversationSyncService,
    private readonly presenter: ConversationPresenter,
    private readonly roles: WorkspaceRoleService,
    private readonly notify: InboxNotifyService,
    private readonly wake: LaterWakeService,
    private readonly realtime: InboxRealtimeService,
  ) {}

  async patch(
    workspaceId: string,
    conversationId: string,
    userId: string,
    body: PatchConversationDto,
    now: Date = new Date(),
  ): Promise<MutationResult> {
    const conv = await this.requireConversation(workspaceId, conversationId);
    return await this.patchLoaded(workspaceId, conv, userId, body, now);
  }

  async bulk(
    workspaceId: string,
    userId: string,
    body: BulkConversationsDto,
    now: Date = new Date(),
  ): Promise<BulkResult> {
    if (body.action === 'assign' && body.assigneeUserId === undefined) {
      // A missing key must never read as "unassign everything"; null is explicit.
      throw new BadRequestException(
        'assigneeUserId is required (null unassigns)',
      );
    }
    const rows: ConversationRow[] = [];
    const previous: BulkResult['undo']['previous'] = {};
    for (const id of new Set(body.ids)) {
      const conv = await this.findConversation(workspaceId, id);
      if (!conv) continue;
      if (body.action === 'unread') {
        try {
          const res = await this.markUnread(workspaceId, id, userId);
          rows.push(res.row);
          previous[id] = {};
        } catch (err) {
          // A thread with no inbound message cannot be unread; skip it.
          if (!(err instanceof BadRequestException)) throw err;
        }
        continue;
      }
      const patch: PatchConversationDto =
        body.action === 'done'
          ? { status: 'done' }
          : body.action === 'assign'
            ? { assigneeUserId: body.assigneeUserId }
            : {
                status: 'later',
                laterUntil: body.laterUntil,
                laterUntilReply: body.laterUntilReply,
                laterPreset: body.laterPreset,
              };
      const res = await this.patchLoaded(workspaceId, conv, userId, patch, now);
      rows.push(res.row);
      previous[id] = res.undo ?? {};
    }
    return { rows, undo: { ids: Object.keys(previous), previous } };
  }

  /** Read state is shared across the workspace (D4), so the user is not recorded. */
  async markRead(
    workspaceId: string,
    conversationId: string,
  ): Promise<{ row: ConversationRow }> {
    const conv = await this.requireConversation(workspaceId, conversationId);
    await this.db.execute(sql`
      UPDATE inbox_items SET status = 'needs_reply'
       WHERE workspace_id = ${workspaceId}::uuid
         AND thread_key = ${conv.thread_key}
         AND NOT from_me AND status = 'unread'
    `);
    await this.sync.syncThread(workspaceId, conv.thread_key);
    return { row: await this.rowOf(workspaceId, conversationId) };
  }

  async markUnread(
    workspaceId: string,
    conversationId: string,
    userId?: string,
  ): Promise<MutationResult> {
    void userId; // read state is workspace-wide; kept for a uniform signature
    const conv = await this.requireConversation(workspaceId, conversationId);
    const res = await this.db.execute<{ id: string }>(sql`
      UPDATE inbox_items SET status = 'unread'
       WHERE id = (
         SELECT id FROM inbox_items
          WHERE workspace_id = ${workspaceId}::uuid
            AND thread_key = ${conv.thread_key}
            AND NOT from_me AND NOT is_hidden
          ORDER BY platform_created_at DESC, id DESC
          LIMIT 1
       )
       RETURNING id
    `);
    if (res.rows.length === 0) {
      throw new BadRequestException('Nothing to mark unread');
    }
    await this.sync.syncThread(workspaceId, conv.thread_key);
    return { row: await this.rowOf(workspaceId, conversationId), undo: null };
  }

  async remove(
    workspaceId: string,
    conversationId: string,
  ): Promise<{ ok: true }> {
    const conv = await this.requireConversation(workspaceId, conversationId);
    await this.db.execute(sql`
      UPDATE inbox_items SET archived_at = now()
       WHERE workspace_id = ${workspaceId}::uuid
         AND thread_key = ${conv.thread_key}
         AND archived_at IS NULL
    `);
    await this.sync.syncThread(workspaceId, conv.thread_key);
    this.realtime.conversationRemoved(workspaceId, conversationId);
    return { ok: true };
  }

  async restore(
    workspaceId: string,
    conversationId: string,
  ): Promise<{ row: ConversationRow }> {
    const conv = await this.requireConversation(workspaceId, conversationId);
    await this.db.execute(sql`
      UPDATE inbox_items SET archived_at = NULL
       WHERE workspace_id = ${workspaceId}::uuid
         AND thread_key = ${conv.thread_key}
    `);
    await this.sync.syncThread(workspaceId, conv.thread_key);
    return { row: await this.rowOf(workspaceId, conversationId) };
  }

  private async patchLoaded(
    workspaceId: string,
    conv: ConversationRef,
    userId: string,
    body: PatchConversationDto,
    now: Date,
  ): Promise<MutationResult> {
    const prev: PatchState = {
      status: conv.status,
      laterUntil: toDate(conv.later_until),
      laterUntilReply: conv.later_until_reply,
      assigneeUserId: conv.assignee_user_id,
    };

    const hasLaterFields =
      body.laterUntil !== undefined ||
      body.laterPreset !== undefined ||
      body.laterUntilReply !== undefined;
    if (hasLaterFields && body.status !== 'later') {
      throw new BadRequestException(
        "laterUntil, laterPreset and laterUntilReply require status 'later'",
      );
    }

    let laterUntil: Date | null = null;
    if (body.status === 'later') {
      laterUntil = await this.resolveLaterUntil(workspaceId, body, now);
    }
    if (body.assigneeUserId) {
      await this.assertCanBeAssigned(workspaceId, body.assigneeUserId);
    }

    const intent: SyncIntent = {
      kind: 'manual',
      userId,
      ...(body.status !== undefined && { status: body.status }),
      ...(body.status === 'later' && {
        laterUntil,
        laterUntilReply: body.laterUntilReply ?? false,
      }),
      ...(body.assigneeUserId !== undefined && {
        assignee: { userId: body.assigneeUserId },
      }),
    };
    // Commits before anything below runs (D1).
    await this.sync.syncThread(workspaceId, conv.thread_key, intent, now);

    if (laterUntil) {
      try {
        await this.wake.schedule(conv.id, laterUntil, now);
      } catch (err) {
        // Committed already; the minute sweep wakes it if the job was lost.
        this.logger.warn(
          `wake job not scheduled for ${conv.id}: ${(err as Error).message}`,
        );
      }
    }
    if (body.assigneeUserId && body.assigneeUserId !== prev.assigneeUserId) {
      await this.notify.assigned({
        workspaceId,
        conversationId: conv.id,
        assigneeUserId: body.assigneeUserId,
        actorUserId: userId,
      });
    }
    return {
      row: await this.rowOf(workspaceId, conv.id, now),
      undo: undoFor(body, prev),
    };
  }

  private async resolveLaterUntil(
    workspaceId: string,
    body: PatchConversationDto,
    now: Date,
  ): Promise<Date | null> {
    if (body.laterUntil) return new Date(body.laterUntil);
    if (body.laterPreset) {
      const tz = await loadWorkspaceTimezone(this.db, workspaceId);
      const at = resolveLaterPreset(body.laterPreset, now, tz);
      if (!at) throw new BadRequestException('That time has passed');
      return at;
    }
    if (body.laterUntilReply === true) return null;
    throw new BadRequestException(
      'Later needs laterUntil, laterPreset or laterUntilReply',
    );
  }

  private async assertCanBeAssigned(
    workspaceId: string,
    assigneeUserId: string,
  ): Promise<void> {
    const role = await this.roles.getRole(workspaceId, assigneeUserId);
    if (!role || !roleCan(role, 'inbox:reply')) {
      throw new BadRequestException('Assignee must be a member who can reply');
    }
  }

  private async findConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationRef | null> {
    const res = await this.db.execute<ConversationRef>(sql`
      SELECT id, thread_key, status, later_until, later_until_reply,
             assignee_user_id
        FROM inbox_conversations
       WHERE id = ${conversationId}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `);
    return res.rows[0] ?? null;
  }

  private async requireConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationRef> {
    const conv = await this.findConversation(workspaceId, conversationId);
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  private async rowOf(
    workspaceId: string,
    conversationId: string,
    now?: Date,
  ): Promise<ConversationRow> {
    const [row] = await this.presenter.loadRows(
      workspaceId,
      [conversationId],
      now,
    );
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }
}
