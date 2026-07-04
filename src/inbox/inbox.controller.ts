import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InboxService } from './inbox.service';
import { ScheduledMessagesService } from './services/scheduled-messages.service';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { ListCommentsDto } from './dto/list-comments.dto';
import { ReplyDto } from './dto/reply.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { HideDto } from './dto/hide.dto';
import { CreateScheduledMessageDto } from './dto/create-scheduled-message.dto';
import { UpdateScheduledMessageDto } from './dto/update-scheduled-message.dto';
import { ListScheduledMessagesDto } from './dto/list-scheduled-messages.dto';
import { CreateInboxUploadUrlDto } from './dto/create-upload-url.dto';
import { SendDmDto } from './dto/send-dm.dto';

interface AuthUser {
  userId: string;
  email: string;
}

@Controller('inbox/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly scheduledMessagesService: ScheduledMessagesService,
    private readonly r2Service: CloudflareR2Service,
  ) {}

  @Get('comments')
  async listComments(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.listCommentThreads(workspaceId, user.userId, {
      channelId: query.channelId,
      folder: query.folder,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /** Flat list of @mentions (account-level, not tied to a post/thread). */
  @Get('mentions')
  async mentions(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.listMentions(workspaceId, user.userId, {
      channelId: query.channelId,
      folder: query.folder,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('threads/:threadKey')
  async getThread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getThread(workspaceId, user.userId, threadKey);
  }

  @Post('comments/:itemId/reply')
  async reply(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ReplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.reply(workspaceId, user.userId, itemId, dto.text);
  }

  @Post('threads/:threadKey/comments')
  async commentOnPost(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: ReplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.commentOnPost(
      workspaceId,
      user.userId,
      threadKey,
      dto.text,
    );
  }

  @Patch('comments/:itemId/status')
  async updateStatus(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.updateStatus(
      workspaceId,
      user.userId,
      itemId,
      dto.status,
    );
  }

  /**
   * Moderate a reply on our own post (Threads `manage_reply` today; other
   * platforms reject with a 400 via `inboxService.hideComment`).
   */
  @Patch('comments/:itemId/hide')
  async hide(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: HideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.hideComment(
      workspaceId,
      user.userId,
      itemId,
      dto.hidden,
    );
  }

  @Patch('threads/:threadKey/status')
  async updateThreadStatus(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.updateThreadStatus(
      workspaceId,
      user.userId,
      threadKey,
      dto.status,
    );
  }

  @Post('threads/:threadKey/read')
  @HttpCode(HttpStatus.OK)
  async markThreadRead(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.markThreadRead(
      workspaceId,
      user.userId,
      threadKey,
    );
  }

  @Get('counts')
  async getCounts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getCounts(workspaceId, user.userId);
  }

  /**
   * Backfill comments on every connected channel in the workspace.
   * Enqueues poll jobs immediately (returns 202). The processor handles each
   * channel async. Use after first connecting a channel, or for manual refresh.
   */
  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async syncNow(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.syncNow(workspaceId, user.userId);
  }

  /**
   * Phase 2.3 diagnostic — what is Meta's view of the webhook subscription
   * for the FB/IG channels in this workspace? Returns per-channel status so
   * we can tell if a channel is actually subscribed vs polling-only.
   *
   * Useful when DMs feel slow ("am I on webhook or polling?"). Compare the
   * `fields` list to what we want (`['messages', 'comments', ...]`).
   */
  @Get('webhook-status')
  async getWebhookStatus(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getWebhookStatus(workspaceId, user.userId);
  }

  // ==========================================================================
  // DM — Phase 2.1
  // ==========================================================================

  @Get('dms')
  async listDmConversations(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.listDmConversations(workspaceId, user.userId, {
      channelId: query.channelId,
      folder: query.folder,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('dms/:threadKey')
  async getDmThread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getDmThread(workspaceId, user.userId, threadKey);
  }

  @Post('dms/:threadKey/messages')
  async sendDm(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: SendDmDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.sendDm(
      workspaceId,
      user.userId,
      threadKey,
      dto.text,
      dto.attachments?.map((a) => ({
        kind: a.kind === 'voice' ? 'audio' : a.kind,
        url: a.url,
        contentType: a.contentType,
      })),
    );
  }

  @Post('dms/:threadKey/read')
  @HttpCode(HttpStatus.OK)
  async markDmRead(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.markDmConversationRead(
      workspaceId,
      user.userId,
      threadKey,
    );
  }

  // ==========================================================================
  // Scheduled messages — Phase 2.2
  // ==========================================================================

  @Get('scheduled')
  async listScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListScheduledMessagesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.list(workspaceId, user.userId, query);
  }

  @Get('scheduled/counts')
  async scheduledCounts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.counts(workspaceId, user.userId);
  }

  @Post('scheduled')
  async createScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateScheduledMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.create(workspaceId, user.userId, dto);
  }

  @Get('scheduled/:id')
  async getScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.get(workspaceId, user.userId, id);
  }

  @Patch('scheduled/:id')
  async updateScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduledMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.update(
      workspaceId,
      user.userId,
      id,
      dto,
    );
  }

  @Delete('scheduled/:id')
  @HttpCode(HttpStatus.OK)
  async cancelScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.cancel(workspaceId, user.userId, id);
  }

  // ==========================================================================
  // Media uploads (Phase 2.3) — presigned PUT URL for inbox DM attachments.
  // Browser uploads directly to Cloudflare R2; backend never touches bytes.
  // ==========================================================================

  @Post('uploads/presign')
  async createUploadUrl(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateInboxUploadUrlDto,
    @CurrentUser() user: AuthUser,
  ) {
    // Workspace access check piggybacks on the inboxService — keeps the rule
    // in one place. Any non-member gets a 403 before R2 is touched.
    await this.inboxService.assertWorkspaceAccessPublic(
      workspaceId,
      user.userId,
    );
    return this.r2Service.createPresignedUpload({
      workspaceId,
      userId: user.userId,
      kind: dto.kind,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filename: dto.filename,
    });
  }

  // ==========================================================================
  // Delete sent items (Phase 2.3) — flips the row to a 'deleted' soft-state
  // AND deletes from the platform side via the per-platform adapter.
  // ==========================================================================

  @Delete('comments/:itemId')
  @HttpCode(HttpStatus.OK)
  async deleteComment(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.deleteComment(workspaceId, user.userId, itemId);
  }

  @Delete('dms/:itemId')
  @HttpCode(HttpStatus.OK)
  async deleteDm(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.deleteDm(workspaceId, user.userId, itemId);
  }

  // ==========================================================================
  // Archive whole conversation/thread (soft "delete" from the inbox only).
  // Deeper paths than dms/:itemId & comments/:itemId so the threadKey
  // (channelId:conversationId, contains colons, not a UUID) doesn't collide.
  // ==========================================================================

  @Delete('dms/conversation/:threadKey')
  @HttpCode(HttpStatus.OK)
  async archiveDmConversation(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.archiveDmConversation(
      workspaceId,
      user.userId,
      threadKey,
    );
  }

  @Delete('comments/thread/:threadKey')
  @HttpCode(HttpStatus.OK)
  async archiveCommentThread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.archiveCommentThread(
      workspaceId,
      user.userId,
      threadKey,
    );
  }
}
