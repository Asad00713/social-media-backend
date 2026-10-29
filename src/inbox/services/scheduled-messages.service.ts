import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  scheduledInboxMessages,
  type ScheduledAttachment,
  type ScheduledInboxMessage,
  type ScheduledInboxStatus,
  type ScheduledInboxType,
} from '../../drizzle/schema/scheduled-inbox-messages.schema';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import {
  inboxConversations,
  type InboxConversationKind,
} from '../../drizzle/schema/inbox-conversations.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../drizzle/schema/workspace-invitation.schema';
import { QUEUES } from '../../queue/queue.module';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import { CalendarPushSyncService } from '../../calendar-sync/services/calendar-push-sync.service';
import { InboxRealtimeService } from '../conversations/services/inbox-realtime.service';
import { scheduledEntryOf } from '../conversations/lib/timeline-entry';
import type { Attachment, UserRef } from '../conversations/dto/contract';
import type { DmAttachmentDto } from '../dto/send-dm.dto';
import type { CreateScheduledMessageDto } from '../dto/create-scheduled-message.dto';
import type { UpdateScheduledMessageDto } from '../dto/update-scheduled-message.dto';
import type { ListScheduledMessagesDto } from '../dto/list-scheduled-messages.dto';
import type { ScheduledInboxEventBase } from '../../realtime/types/analytics-events.types';

const MIN_LEAD_MS = 2 * 60 * 1000; // 2 minutes

export interface ScheduledMessageDto {
  id: string;
  workspaceId: string;
  channelId: number;
  type: ScheduledInboxType;
  threadKey: string;
  parentItemId: string | null;
  platformPostId: string | null;
  conversationId: string | null;
  targetLabel: string | null;
  text: string;
  textPreview: string;
  scheduledAt: string;
  timezone: string | null;
  status: ScheduledInboxStatus;
  createdByUserId: string | null;
  sentInboxItemId: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  platform?: SupportedPlatform;
}

/**
 * The scheduled-message shape every route returns. A permanent superset of
 * `ScheduledMessageDto`: the Planner keeps reading the old fields, the new
 * Inbox reads the new ones.
 */
export interface ScheduledDto extends ScheduledMessageDto {
  /** The inbox_conversations row; `conversationId` stays the platform id. */
  inboxConversationId: string | null;
  sendAt: string;
  by: UserRef | null;
  attachments: Attachment[];
  error: string | null;
}

export interface CancelResultDto {
  ok: true;
  undo: { restoreId: string };
  /** The old body, kept until the old Inbox is removed (Task 25). */
  success: true;
}

interface ConversationRef {
  id: string;
  kind: InboxConversationKind;
  threadKey: string;
  replyWindowClosesAt: Date | null;
}

const WINDOW_MARGIN_MS = 60_000;

export interface ScheduledCountsDto {
  total: number;
  perThread: Record<string, number>;
  perChannel: Record<string, number>;
}

@Injectable()
export class ScheduledMessagesService {
  private readonly logger = new Logger(ScheduledMessagesService.name);

  constructor(
    private readonly emitter: AnalyticsEventEmitter,
    @InjectQueue(QUEUES.SCHEDULED_INBOX) private readonly queue: Queue,
    // InboxModule ↔ CalendarSyncModule is a circular module pair (scheduled
    // messages push to calendars, calendars write back to scheduled messages)
    // → forwardRef on both module imports. Mirrors PostService ↔ CalendarSync.
    private readonly calendarPushSync: CalendarPushSyncService,
    private readonly realtime: InboxRealtimeService,
  ) {}

  /**
   * Fire-and-forget app→calendar push for a scheduled message. Never blocks or
   * fails the originating inbox operation — calendar sync is best-effort and
   * self-heals via backfill/reconcile. Errors are logged inside the push service.
   * Mirrors `PostService.syncCalendarForPost`.
   */
  private syncCalendarForMessage(messageId: string): void {
    void this.calendarPushSync.syncMessage(messageId).catch((error) => {
      this.logger.warn(
        `Calendar sync failed for scheduled message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Workspace access (mirrors InboxService.assertWorkspaceAccess)
  // ──────────────────────────────────────────────────────────────────────────
  private async assertWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const owned = await db.query.workspace.findFirst({
      where: and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)),
      columns: { id: true },
    });
    if (owned) return;
    const member = await db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
      columns: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('No access to this workspace');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────
  private jobIdFor(scheduledId: string): string {
    return `scheduled-inbox-${scheduledId}`;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toDto(
    row: ScheduledInboxMessage,
    platform?: SupportedPlatform,
  ): ScheduledMessageDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      type: row.type,
      threadKey: row.threadKey,
      parentItemId: row.parentItemId,
      platformPostId: row.platformPostId,
      conversationId: row.conversationId,
      targetLabel: row.targetLabel,
      text: row.text,
      textPreview: this.stripHtml(row.text).slice(0, 280),
      scheduledAt: row.scheduledAt.toISOString(),
      timezone: row.timezone,
      status: row.status,
      createdByUserId: row.createdByUserId,
      sentInboxItemId: row.sentInboxItemId,
      errorMessage: row.errorMessage,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      platform,
    };
  }

  /** Every old field unchanged, plus the Inbox superset (`ScheduledDto`). */
  toScheduledDto(
    row: ScheduledInboxMessage,
    by: UserRef | null,
    platform?: SupportedPlatform,
    inboxConversationId: string | null = row.inboxConversationId,
  ): ScheduledDto {
    return {
      ...this.toDto(row, platform),
      inboxConversationId,
      sendAt: row.scheduledAt.toISOString(),
      by,
      attachments: row.attachments ?? [],
      error: row.errorMessage,
    };
  }

  /**
   * Presents rows with their creators and conversations resolved in batches.
   * A legacy row without `inbox_conversation_id` is matched by
   * `(workspace_id, thread_key)`.
   */
  private async presentMany(
    rows: ScheduledInboxMessage[],
    platformByChannel?: Map<number, SupportedPlatform>,
  ): Promise<ScheduledDto[]> {
    if (rows.length === 0) return [];

    const platforms =
      platformByChannel ??
      (await this.platformsOf(rows.map((r) => r.channelId)));

    const userIds = Array.from(
      new Set(rows.map((r) => r.createdByUserId).filter((u) => u !== null)),
    );
    const byUser = new Map<string, UserRef>();
    if (userIds.length > 0) {
      const found = await db
        .select({
          id: users.id,
          name: users.name,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const u of found) {
        byUser.set(u.id, {
          id: u.id,
          name: u.name ?? '',
          avatarUrl: u.avatarUrl,
        });
      }
    }

    const unlinked = rows.filter((r) => r.inboxConversationId === null);
    const convByKey = new Map<string, string>();
    if (unlinked.length > 0) {
      const found = await db
        .select({
          id: inboxConversations.id,
          workspaceId: inboxConversations.workspaceId,
          threadKey: inboxConversations.threadKey,
        })
        .from(inboxConversations)
        .where(
          and(
            inArray(
              inboxConversations.workspaceId,
              Array.from(new Set(unlinked.map((r) => r.workspaceId))),
            ),
            inArray(
              inboxConversations.threadKey,
              Array.from(new Set(unlinked.map((r) => r.threadKey))),
            ),
          ),
        );
      for (const c of found) {
        convByKey.set(`${c.workspaceId}|${c.threadKey}`, c.id);
      }
    }

    return rows.map((row) =>
      this.toScheduledDto(
        row,
        row.createdByUserId ? (byUser.get(row.createdByUserId) ?? null) : null,
        platforms.get(row.channelId),
        row.inboxConversationId ??
          convByKey.get(`${row.workspaceId}|${row.threadKey}`) ??
          null,
      ),
    );
  }

  private async platformsOf(
    channelIds: number[],
  ): Promise<Map<number, SupportedPlatform>> {
    const found = await db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
      })
      .from(socialMediaChannels)
      .where(inArray(socialMediaChannels.id, Array.from(new Set(channelIds))));
    return new Map(found.map((c) => [c.id, c.platform as SupportedPlatform]));
  }

  private async presentOne(row: ScheduledInboxMessage): Promise<ScheduledDto> {
    const [dto] = await this.presentMany([row]);
    return dto;
  }

  /**
   * Tells the Inbox views a scheduled reply changed. Called only after the
   * database write has committed; a realtime failure never fails the operation.
   * A reply that is no longer waiting (sent, cancelled) appends no entry.
   */
  private async announce(
    row: ScheduledInboxMessage,
    presented?: ScheduledDto,
  ): Promise<void> {
    try {
      const dto = presented ?? (await this.presentOne(row));
      const convId = dto.inboxConversationId;
      if (convId) {
        const waiting = row.status !== 'sent' && row.status !== 'cancelled';
        this.realtime.timelineAppended(
          row.workspaceId,
          convId,
          waiting ? scheduledEntryOf(row, dto.by) : null,
          row.parentItemId,
        );
        this.realtime.conversationChanged(row.workspaceId, convId);
      }
      this.realtime.countsChanged(row.workspaceId);
    } catch (error) {
      this.logger.warn(
        `Realtime announce failed for scheduled message ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Presents the row, announces it, and returns the presented form. */
  private async finish(row: ScheduledInboxMessage): Promise<ScheduledDto> {
    const dto = await this.presentOne(row);
    await this.announce(row, dto);
    return dto;
  }

  private async findConversation(
    workspaceId: string,
    by: { id: string } | { threadKey: string },
  ): Promise<ConversationRef | null> {
    const [row] = await db
      .select({
        id: inboxConversations.id,
        kind: inboxConversations.kind,
        threadKey: inboxConversations.threadKey,
        replyWindowClosesAt: inboxConversations.replyWindowClosesAt,
      })
      .from(inboxConversations)
      .where(
        and(
          eq(inboxConversations.workspaceId, workspaceId),
          'id' in by
            ? eq(inboxConversations.id, by.id)
            : eq(inboxConversations.threadKey, by.threadKey),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private sendTimePassed(): ConflictException {
    return new ConflictException({
      code: 'SEND_TIME_PASSED',
      message: 'That time has passed',
    });
  }

  /** Not in the future → 409 SEND_TIME_PASSED; under the 2 minute lead → 400. */
  private assertSendTime(sendAt: Date): number {
    const delay = sendAt.getTime() - Date.now();
    if (delay <= 0) throw this.sendTimePassed();
    if (delay < MIN_LEAD_MS) {
      throw new BadRequestException(
        'scheduledAt must be at least 2 minutes in the future',
      );
    }
    return delay;
  }

  private assertInsideReplyWindow(
    sendAt: Date,
    conversation: ConversationRef | null,
  ): void {
    const closes = conversation?.replyWindowClosesAt;
    if (closes && sendAt.getTime() > closes.getTime() - WINDOW_MARGIN_MS) {
      throw new BadRequestException(
        'That time is after the reply window closes',
      );
    }
  }

  private toStoredAttachments(
    attachments: DmAttachmentDto[],
  ): ScheduledAttachment[] {
    return attachments.map((a) => ({
      kind: a.kind,
      url: a.url,
      contentType: a.contentType,
      thumbnailUrl: null,
    }));
  }

  /**
   * (Re)arms the delayed BullMQ job for a row. BullMQ ignores an add whose job
   * id already exists in ANY state, so a prior job is removed first. The id
   * must never contain ':' (BullMQ rejects it; that crashed prod once).
   */
  private async armJob(
    id: string,
    delay: number,
    replace: boolean,
  ): Promise<string> {
    const jobId = this.jobIdFor(id);
    if (replace) {
      const prior = await this.queue.getJob(jobId);
      if (prior) await prior.remove();
    }
    await this.queue.add(
      'fire',
      { scheduledId: id },
      { jobId, delay: Math.max(0, delay), attempts: 3 },
    );
    return jobId;
  }

  private toEventBase(row: ScheduledInboxMessage): ScheduledInboxEventBase {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      type: row.type,
      threadKey: row.threadKey,
      status: row.status,
      scheduledAt: row.scheduledAt.toISOString(),
      textPreview: this.stripHtml(row.text).slice(0, 280),
      targetLabel: row.targetLabel,
      parentItemId: row.parentItemId,
      platformPostId: row.platformPostId,
      conversationId: row.conversationId,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Channel + thread validation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a threadKey into its components based on the scheduled type +
   * optional parentItemId.
   *
   * - dm:                 `<channelId>:<conversationId>`     (no parentItemId)
   * - comment top-level:  `<channelId>:<platformPostId>`     (no parentItemId)
   * - comment nested:     parentItemId IS the inbox_items uuid; threadKey is
   *                       the parent's `<channelId>:<platformPostId>` so the
   *                       message routes back into the same thread view.
   */
  private async resolveTarget(
    workspaceId: string,
    dto: {
      type: ScheduledInboxType;
      threadKey: string;
      parentItemId?: string;
    },
  ): Promise<{
    channelId: number;
    platform: SupportedPlatform;
    platformPostId: string | null;
    conversationId: string | null;
    parentItemId: string | null;
  }> {
    if (dto.type === 'dm') {
      const [channelIdStr, ...rest] = dto.threadKey.split(':');
      const conversationId = rest.join(':');
      const channelId = Number(channelIdStr);
      if (!Number.isFinite(channelId) || !conversationId) {
        throw new BadRequestException(
          'Invalid threadKey for DM — expected `<channelId>:<conversationId>`',
        );
      }
      const channel = await this.getChannelOrThrow(workspaceId, channelId);
      return {
        channelId,
        platform: channel.platform as SupportedPlatform,
        platformPostId: null,
        conversationId,
        parentItemId: null,
      };
    }

    // type === 'comment'
    if (dto.parentItemId) {
      const parent = await db.query.inboxItems.findFirst({
        where: and(
          eq(inboxItems.id, dto.parentItemId),
          eq(inboxItems.workspaceId, workspaceId),
        ),
      });
      if (!parent) {
        throw new NotFoundException('Parent comment not found');
      }
      const channel = await this.getChannelOrThrow(
        workspaceId,
        parent.channelId,
      );
      return {
        channelId: parent.channelId,
        platform: channel.platform as SupportedPlatform,
        platformPostId: parent.platformPostId,
        conversationId: null,
        parentItemId: parent.id,
      };
    }

    // top-level comment on a post
    const [channelIdStr, ...rest] = dto.threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);
    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException(
        'Invalid threadKey for comment — expected `<channelId>:<platformPostId>`',
      );
    }
    const channel = await this.getChannelOrThrow(workspaceId, channelId);
    return {
      channelId,
      platform: channel.platform as SupportedPlatform,
      platformPostId,
      conversationId: null,
      parentItemId: null,
    };
  }

  private async getChannelOrThrow(workspaceId: string, channelId: number) {
    const channel = await db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.id, channelId),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.connectionStatus !== 'connected' || !channel.isActive) {
      throw new BadRequestException(
        'Channel is not connected — reconnect before scheduling',
      );
    }
    return channel;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateScheduledMessageDto,
  ): Promise<ScheduledDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const sendAtRaw = dto.sendAt ?? dto.scheduledAt;
    if (!sendAtRaw) {
      throw new BadRequestException('sendAt is required');
    }
    const scheduledAt = new Date(sendAtRaw);
    const delay = this.assertSendTime(scheduledAt);

    const trimmedText = dto.text.trim();
    if (!this.stripHtml(trimmedText)) {
      throw new BadRequestException('Message text cannot be empty');
    }

    // Either shape ends in a type, a thread key and (when known) the
    // conversation row; the validators guarantee exactly one shape.
    let conversation: ConversationRef | null;
    let type: ScheduledInboxType;
    let threadKey: string;
    if (dto.inboxConversationId) {
      conversation = await this.findConversation(workspaceId, {
        id: dto.inboxConversationId,
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      type = conversation.kind === 'dm' ? 'dm' : 'comment';
      threadKey = conversation.threadKey;
    } else {
      if (!dto.type || !dto.threadKey) {
        throw new BadRequestException(
          'Send inboxConversationId, or type together with threadKey',
        );
      }
      type = dto.type;
      threadKey = dto.threadKey;
      conversation = await this.findConversation(workspaceId, { threadKey });
    }

    const attachments = dto.attachments ?? [];
    if (attachments.length > 0 && type !== 'dm') {
      throw new BadRequestException(
        'Attachments can only be scheduled on messages',
      );
    }
    this.assertInsideReplyWindow(scheduledAt, conversation);

    const target = await this.resolveTarget(workspaceId, {
      type,
      threadKey,
      parentItemId: dto.parentItemId,
    });

    const [row] = await db
      .insert(scheduledInboxMessages)
      .values({
        workspaceId,
        channelId: target.channelId,
        type,
        threadKey,
        parentItemId: target.parentItemId,
        platformPostId: target.platformPostId,
        conversationId: target.conversationId,
        inboxConversationId: conversation?.id ?? null,
        targetLabel: dto.targetLabel ?? null,
        text: trimmedText,
        attachments: this.toStoredAttachments(attachments),
        scheduledAt,
        timezone: dto.timezone ?? null,
        status: 'pending',
        createdByUserId: userId,
      })
      .returning();

    // The row is committed; only now does the job and any event go out.
    const jobId = await this.armJob(row.id, delay, false);

    await db
      .update(scheduledInboxMessages)
      .set({ queueJobId: jobId, updatedAt: new Date() })
      .where(eq(scheduledInboxMessages.id, row.id));

    this.logger.log(
      `Scheduled ${type} ${row.id} for ${scheduledAt.toISOString()} (delay=${delay}ms, channel=${target.channelId})`,
    );

    const refreshed = { ...row, queueJobId: jobId } as ScheduledInboxMessage;
    this.emitter.emit(
      workspaceId,
      'scheduled.message.created',
      this.toEventBase(refreshed),
    );

    // Mirror the new scheduled message onto the workspace's connected calendars.
    this.syncCalendarForMessage(row.id);

    return this.finish(refreshed);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateScheduledMessageDto,
  ): Promise<ScheduledDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    return this.applyUpdate(workspaceId, id, dto);
  }

  /**
   * SYSTEM-INTERNAL update — same behaviour as `update()` (validation, BullMQ job
   * re-arm, realtime event, calendar push) but WITHOUT the per-user workspace
   * access check, because the caller is not a user.
   *
   * Used by the calendar write-back path (`CalendarPullSyncService`): when the
   * user drags one of our events in Google/Outlook, the reschedule arrives with
   * no authenticated user, and `createdByUserId` is nullable so it cannot be
   * relied on as a stand-in. The provider event is itself the authorization —
   * it only exists because this workspace connected that calendar.
   */
  async updateFromCalendar(
    workspaceId: string,
    id: string,
    dto: UpdateScheduledMessageDto,
  ): Promise<ScheduledDto> {
    return this.applyUpdate(workspaceId, id, dto);
  }

  private async applyUpdate(
    workspaceId: string,
    id: string,
    dto: UpdateScheduledMessageDto,
  ): Promise<ScheduledDto> {
    const existing = await this.loadOrThrow(workspaceId, id);
    if (existing.status !== 'pending') {
      throw new ConflictException(
        `Cannot edit a scheduled message in status '${existing.status}'`,
      );
    }

    const updates: Partial<ScheduledInboxMessage> = { updatedAt: new Date() };

    if (dto.text !== undefined) {
      const trimmed = dto.text.trim();
      if (!this.stripHtml(trimmed)) {
        throw new BadRequestException('Message text cannot be empty');
      }
      updates.text = trimmed;
    }

    if (dto.attachments !== undefined) {
      if (dto.attachments.length > 0 && existing.type !== 'dm') {
        throw new BadRequestException(
          'Attachments can only be scheduled on messages',
        );
      }
      updates.attachments = this.toStoredAttachments(dto.attachments);
    }

    let newScheduledAt: Date | null = null;
    const sendAtRaw = dto.sendAt ?? dto.scheduledAt;
    if (sendAtRaw) {
      newScheduledAt = new Date(sendAtRaw);
      this.assertSendTime(newScheduledAt);
      const conversation = existing.inboxConversationId
        ? await this.findConversation(workspaceId, {
            id: existing.inboxConversationId,
          })
        : await this.findConversation(workspaceId, {
            threadKey: existing.threadKey,
          });
      this.assertInsideReplyWindow(newScheduledAt, conversation);
      updates.scheduledAt = newScheduledAt;
    }
    if (dto.timezone !== undefined) {
      updates.timezone = dto.timezone;
    }
    if (newScheduledAt) updates.queueJobId = this.jobIdFor(id);

    const [row] = await db
      .update(scheduledInboxMessages)
      .set(updates)
      .where(eq(scheduledInboxMessages.id, id))
      .returning();

    // If the time changed, swap the BullMQ job — after the write has committed.
    if (newScheduledAt) {
      await this.armJob(id, newScheduledAt.getTime() - Date.now(), true);
    }

    this.emitter.emit(
      workspaceId,
      'scheduled.message.updated',
      this.toEventBase(row),
    );

    // Reflect the new time/text on connected calendars. When the update ORIGINATED
    // from a calendar move the pull service has already stamped the link with the
    // hash of exactly this body, so this push is a no-op (no ping-pong).
    this.syncCalendarForMessage(id);

    return this.finish(row);
  }

  async cancel(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<CancelResultDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    return this.applyCancel(workspaceId, id);
  }

  /**
   * SYSTEM-INTERNAL cancel — identical to `cancel()` (BullMQ delayed-job removal,
   * status → 'cancelled', realtime event) minus the per-user access check. See
   * `updateFromCalendar()` for why the calendar write-back path needs this.
   *
   * NOTE: no calendar push hook here — the caller (the pull service) is reacting
   * to the event ALREADY being deleted in the provider, and it drops the link row
   * itself. Pushing would only chase a 404.
   */
  async cancelFromCalendar(
    workspaceId: string,
    id: string,
  ): Promise<CancelResultDto> {
    return this.applyCancel(workspaceId, id, { pushToCalendar: false });
  }

  private async applyCancel(
    workspaceId: string,
    id: string,
    options: { pushToCalendar?: boolean } = {},
  ): Promise<CancelResultDto> {
    const { pushToCalendar = true } = options;
    const result: CancelResultDto = {
      ok: true,
      undo: { restoreId: id },
      success: true,
    };

    const existing = await this.loadOrThrow(workspaceId, id);
    if (existing.status !== 'pending') {
      // Already done — treat as idempotent for failed/cancelled, conflict for sending/sent.
      if (existing.status === 'sending' || existing.status === 'sent') {
        throw new ConflictException(
          `Cannot cancel — message is ${existing.status}`,
        );
      }
      return result;
    }

    // Flip the status first: a fire that races this finds nothing to claim.
    const [row] = await db
      .update(scheduledInboxMessages)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(scheduledInboxMessages.id, id),
          eq(scheduledInboxMessages.status, 'pending'),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException(
        'Cannot cancel — message is no longer pending',
      );
    }

    const prior = await this.queue.getJob(this.jobIdFor(id));
    if (prior) await prior.remove();

    this.emitter.emit(workspaceId, 'scheduled.message.cancelled', {
      id,
      workspaceId,
      channelId: existing.channelId,
      threadKey: existing.threadKey,
    });

    // A cancelled message must NOT keep a live calendar event — syncMessage sees
    // a non-pending row and removes the event + link on every calendar.
    if (pushToCalendar) {
      this.syncCalendarForMessage(id);
    }

    await this.announce(row);
    return result;
  }

  /** Brings a cancelled reply back (the Undo of a cancel). */
  async restore(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ScheduledDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const existing = await this.loadOrThrow(workspaceId, id);
    if (existing.status !== 'cancelled') {
      throw new ConflictException(
        `Cannot restore a scheduled message in status '${existing.status}'`,
      );
    }
    const delay = existing.scheduledAt.getTime() - Date.now();
    if (delay < MIN_LEAD_MS) throw this.sendTimePassed();

    const [row] = await db
      .update(scheduledInboxMessages)
      .set({
        status: 'pending',
        errorMessage: null,
        queueJobId: this.jobIdFor(id),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduledInboxMessages.id, id),
          eq(scheduledInboxMessages.status, 'cancelled'),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException(
        'Cannot restore — message is no longer cancelled',
      );
    }

    await this.armJob(id, delay, true);
    this.emitter.emit(
      workspaceId,
      'scheduled.message.updated',
      this.toEventBase(row),
    );
    this.syncCalendarForMessage(id);
    return this.finish(row);
  }

  /** Fires a pending or failed reply right now. */
  async sendNow(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ScheduledDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const existing = await this.loadOrThrow(workspaceId, id);
    if (existing.status !== 'pending' && existing.status !== 'failed') {
      throw new ConflictException(
        `Cannot send a scheduled message in status '${existing.status}'`,
      );
    }

    const [row] = await db
      .update(scheduledInboxMessages)
      .set({
        scheduledAt: new Date(),
        status: 'pending',
        attempts: 0,
        errorMessage: null,
        queueJobId: this.jobIdFor(id),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduledInboxMessages.id, id),
          inArray(scheduledInboxMessages.status, ['pending', 'failed']),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('Cannot send — message is no longer waiting');
    }

    await this.armJob(id, 0, true);
    this.emitter.emit(
      workspaceId,
      'scheduled.message.updated',
      this.toEventBase(row),
    );
    this.syncCalendarForMessage(id);
    return this.finish(row);
  }

  private async loadOrThrow(
    workspaceId: string,
    id: string,
  ): Promise<ScheduledInboxMessage> {
    const row = await db.query.scheduledInboxMessages.findFirst({
      where: and(
        eq(scheduledInboxMessages.id, id),
        eq(scheduledInboxMessages.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Scheduled message not found');
    return row;
  }

  async get(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ScheduledDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    return this.presentOne(await this.loadOrThrow(workspaceId, id));
  }

  async list(
    workspaceId: string,
    userId: string,
    options: ListScheduledMessagesDto,
  ): Promise<ScheduledDto[]> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const conditions = [eq(scheduledInboxMessages.workspaceId, workspaceId)];
    if (options.channelId && options.channelId !== 'all') {
      const n = Number(options.channelId);
      if (Number.isFinite(n))
        conditions.push(eq(scheduledInboxMessages.channelId, n));
    }
    if (options.threadKey) {
      conditions.push(eq(scheduledInboxMessages.threadKey, options.threadKey));
    }
    if (options.from) {
      conditions.push(
        gte(scheduledInboxMessages.scheduledAt, new Date(options.from)),
      );
    }
    if (options.to) {
      conditions.push(
        lte(scheduledInboxMessages.scheduledAt, new Date(options.to)),
      );
    }
    if (options.status) {
      conditions.push(eq(scheduledInboxMessages.status, options.status));
    } else {
      // Default: surface pending + failed (anything not yet done/cancelled).
      conditions.push(
        inArray(scheduledInboxMessages.status, ['pending', 'failed']),
      );
    }

    const rows = await db
      .select()
      .from(scheduledInboxMessages)
      .where(and(...conditions))
      .orderBy(scheduledInboxMessages.scheduledAt);

    return this.presentMany(rows);
  }

  async counts(
    workspaceId: string,
    userId: string,
  ): Promise<ScheduledCountsDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const rows = await db
      .select({
        id: scheduledInboxMessages.id,
        channelId: scheduledInboxMessages.channelId,
        threadKey: scheduledInboxMessages.threadKey,
      })
      .from(scheduledInboxMessages)
      .where(
        and(
          eq(scheduledInboxMessages.workspaceId, workspaceId),
          eq(scheduledInboxMessages.status, 'pending'),
        ),
      );

    const perThread: Record<string, number> = {};
    const perChannel: Record<string, number> = {};
    for (const r of rows) {
      perThread[r.threadKey] = (perThread[r.threadKey] ?? 0) + 1;
      perChannel[String(r.channelId)] =
        (perChannel[String(r.channelId)] ?? 0) + 1;
    }
    return { total: rows.length, perThread, perChannel };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — called by the processor on fire success/failure
  // ──────────────────────────────────────────────────────────────────────────

  async claimForFire(id: string): Promise<ScheduledInboxMessage | null> {
    // Transactional flip pending → sending. Race-safe via WHERE status='pending'.
    const updated = await db
      .update(scheduledInboxMessages)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(
        and(
          eq(scheduledInboxMessages.id, id),
          eq(scheduledInboxMessages.status, 'pending'),
        ),
      )
      .returning();
    return updated[0] ?? null;
  }

  async markSent(id: string, inboxItemId: string | null): Promise<void> {
    const [row] = await db
      .update(scheduledInboxMessages)
      .set({
        status: 'sent',
        sentInboxItemId: inboxItemId,
        updatedAt: new Date(),
      })
      .where(eq(scheduledInboxMessages.id, id))
      .returning();
    if (!row) return;
    this.emitter.emit(row.workspaceId, 'scheduled.message.sent', {
      ...this.toEventBase(row),
      inboxItemId,
    });
    // Sent → no longer a *scheduled* item; its calendar event is removed.
    this.syncCalendarForMessage(id);
    await this.announce(row);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const [row] = await db
      .update(scheduledInboxMessages)
      .set({
        status: 'failed',
        errorMessage: error.slice(0, 1000),
        attempts: (await this.bumpAttempts(id)) ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(scheduledInboxMessages.id, id))
      .returning();
    if (!row) return;
    this.emitter.emit(row.workspaceId, 'scheduled.message.failed', {
      ...this.toEventBase(row),
      errorMessage: row.errorMessage ?? error,
    });
    // Terminally failed → the calendar event would be a lie; remove it.
    this.syncCalendarForMessage(id);
    await this.announce(row);
  }

  /** Between BullMQ retries — keep the row claimable by the next attempt. */
  async resetToPendingForRetry(id: string, lastError: string): Promise<void> {
    const attempts = (await this.bumpAttempts(id)) ?? 0;
    await db
      .update(scheduledInboxMessages)
      .set({
        status: 'pending',
        errorMessage: lastError.slice(0, 1000),
        attempts,
        updatedAt: new Date(),
      })
      .where(eq(scheduledInboxMessages.id, id));
  }

  private async bumpAttempts(id: string): Promise<number | null> {
    const existing = await db.query.scheduledInboxMessages.findFirst({
      where: eq(scheduledInboxMessages.id, id),
      columns: { attempts: true },
    });
    return existing ? existing.attempts + 1 : null;
  }

  /** Used by the processor — fetch a row without workspace access checks. */
  async loadForProcessor(id: string): Promise<ScheduledInboxMessage | null> {
    const row = await db.query.scheduledInboxMessages.findFirst({
      where: eq(scheduledInboxMessages.id, id),
    });
    return row ?? null;
  }
}
