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
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  scheduledInboxMessages,
  type ScheduledInboxMessage,
  type ScheduledInboxStatus,
  type ScheduledInboxType,
} from '../../drizzle/schema/scheduled-inbox-messages.schema';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../drizzle/schema/workspace-invitation.schema';
import { QUEUES } from '../../queue/queue.module';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
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
  ) {}

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
      type: row.type as ScheduledInboxType,
      threadKey: row.threadKey,
      parentItemId: row.parentItemId,
      platformPostId: row.platformPostId,
      conversationId: row.conversationId,
      targetLabel: row.targetLabel,
      text: row.text,
      textPreview: this.stripHtml(row.text).slice(0, 280),
      scheduledAt: row.scheduledAt.toISOString(),
      timezone: row.timezone,
      status: row.status as ScheduledInboxStatus,
      createdByUserId: row.createdByUserId,
      sentInboxItemId: row.sentInboxItemId,
      errorMessage: row.errorMessage,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      platform,
    };
  }

  private toEventBase(row: ScheduledInboxMessage): ScheduledInboxEventBase {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      type: row.type as 'comment' | 'dm',
      threadKey: row.threadKey,
      status: row.status as ScheduledInboxStatus,
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
    dto: CreateScheduledMessageDto,
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
      const channel = await this.getChannelOrThrow(workspaceId, parent.channelId);
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
  ): Promise<ScheduledMessageDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const scheduledAt = new Date(dto.scheduledAt);
    const delay = scheduledAt.getTime() - Date.now();
    if (delay < MIN_LEAD_MS) {
      throw new BadRequestException(
        'scheduledAt must be at least 2 minutes in the future',
      );
    }

    const trimmedText = dto.text.trim();
    if (!this.stripHtml(trimmedText)) {
      throw new BadRequestException('Message text cannot be empty');
    }

    const target = await this.resolveTarget(workspaceId, dto);

    const [row] = await db
      .insert(scheduledInboxMessages)
      .values({
        workspaceId,
        channelId: target.channelId,
        type: dto.type,
        threadKey: dto.threadKey,
        parentItemId: target.parentItemId,
        platformPostId: target.platformPostId,
        conversationId: target.conversationId,
        targetLabel: dto.targetLabel ?? null,
        text: trimmedText,
        scheduledAt,
        timezone: dto.timezone ?? null,
        status: 'pending',
        createdByUserId: userId,
      })
      .returning();

    const jobId = this.jobIdFor(row.id);
    await this.queue.add(
      'fire',
      { scheduledId: row.id },
      { jobId, delay, attempts: 3 },
    );

    await db
      .update(scheduledInboxMessages)
      .set({ queueJobId: jobId, updatedAt: new Date() })
      .where(eq(scheduledInboxMessages.id, row.id));

    this.logger.log(
      `Scheduled ${dto.type} ${row.id} for ${scheduledAt.toISOString()} (delay=${delay}ms, channel=${target.channelId})`,
    );

    const refreshed = { ...row, queueJobId: jobId } as ScheduledInboxMessage;
    this.emitter.emit(
      workspaceId,
      'scheduled.message.created',
      this.toEventBase(refreshed),
    );

    return this.toDto(refreshed, target.platform);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateScheduledMessageDto,
  ): Promise<ScheduledMessageDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const existing = await db.query.scheduledInboxMessages.findFirst({
      where: and(
        eq(scheduledInboxMessages.id, id),
        eq(scheduledInboxMessages.workspaceId, workspaceId),
      ),
    });
    if (!existing) throw new NotFoundException('Scheduled message not found');
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

    let newScheduledAt: Date | null = null;
    if (dto.scheduledAt) {
      newScheduledAt = new Date(dto.scheduledAt);
      const delay = newScheduledAt.getTime() - Date.now();
      if (delay < MIN_LEAD_MS) {
        throw new BadRequestException(
          'scheduledAt must be at least 2 minutes in the future',
        );
      }
      updates.scheduledAt = newScheduledAt;
    }
    if (dto.timezone !== undefined) {
      updates.timezone = dto.timezone;
    }

    // If time changed, swap the BullMQ job.
    if (newScheduledAt) {
      const jobId = this.jobIdFor(id);
      const prior = await this.queue.getJob(jobId);
      if (prior) await prior.remove();
      await this.queue.add(
        'fire',
        { scheduledId: id },
        {
          jobId,
          delay: newScheduledAt.getTime() - Date.now(),
          attempts: 3,
        },
      );
      updates.queueJobId = jobId;
    }

    const [row] = await db
      .update(scheduledInboxMessages)
      .set(updates)
      .where(eq(scheduledInboxMessages.id, id))
      .returning();

    const channel = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, row.channelId),
      columns: { platform: true },
    });

    this.emitter.emit(
      workspaceId,
      'scheduled.message.updated',
      this.toEventBase(row),
    );

    return this.toDto(row, channel?.platform as SupportedPlatform | undefined);
  }

  async cancel(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const existing = await db.query.scheduledInboxMessages.findFirst({
      where: and(
        eq(scheduledInboxMessages.id, id),
        eq(scheduledInboxMessages.workspaceId, workspaceId),
      ),
    });
    if (!existing) throw new NotFoundException('Scheduled message not found');
    if (existing.status !== 'pending') {
      // Already done — treat as idempotent for failed/cancelled, conflict for sending/sent.
      if (existing.status === 'sending' || existing.status === 'sent') {
        throw new ConflictException(
          `Cannot cancel — message is ${existing.status}`,
        );
      }
      return { success: true };
    }

    const jobId = this.jobIdFor(id);
    const prior = await this.queue.getJob(jobId);
    if (prior) await prior.remove();

    await db
      .update(scheduledInboxMessages)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(scheduledInboxMessages.id, id));

    this.emitter.emit(workspaceId, 'scheduled.message.cancelled', {
      id,
      workspaceId,
      channelId: existing.channelId,
      threadKey: existing.threadKey,
    });

    return { success: true };
  }

  async get(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ScheduledMessageDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const row = await db.query.scheduledInboxMessages.findFirst({
      where: and(
        eq(scheduledInboxMessages.id, id),
        eq(scheduledInboxMessages.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Scheduled message not found');
    const channel = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, row.channelId),
      columns: { platform: true },
    });
    return this.toDto(row, channel?.platform as SupportedPlatform | undefined);
  }

  async list(
    workspaceId: string,
    userId: string,
    options: ListScheduledMessagesDto,
  ): Promise<ScheduledMessageDto[]> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const conditions = [eq(scheduledInboxMessages.workspaceId, workspaceId)];
    if (options.channelId && options.channelId !== 'all') {
      const n = Number(options.channelId);
      if (Number.isFinite(n)) conditions.push(eq(scheduledInboxMessages.channelId, n));
    }
    if (options.threadKey) {
      conditions.push(eq(scheduledInboxMessages.threadKey, options.threadKey));
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

    if (rows.length === 0) return [];

    const channelIds = Array.from(new Set(rows.map((r) => r.channelId)));
    const channels = await db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
      })
      .from(socialMediaChannels)
      .where(inArray(socialMediaChannels.id, channelIds));
    const platformByChannel = new Map(channels.map((c) => [c.id, c.platform]));

    return rows.map((row) =>
      this.toDto(
        row,
        platformByChannel.get(row.channelId) as SupportedPlatform | undefined,
      ),
    );
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
      perChannel[String(r.channelId)] = (perChannel[String(r.channelId)] ?? 0) + 1;
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
