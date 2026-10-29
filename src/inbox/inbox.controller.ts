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
import { CommentActionsService } from './conversations/services/comment-actions.service';
import { ReplyResponseBuilder } from './conversations/services/reply-response.builder';
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
import { SendDmTemplateDto } from './dto/send-dm-template.dto';
import { toSendOptions } from './dto/send-options.dto';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';

interface AuthUser {
  userId: string;
  email: string;
}

@Controller('inbox/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class InboxController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly scheduledMessagesService: ScheduledMessagesService,
    private readonly r2Service: CloudflareR2Service,
    private readonly commentActions: CommentActionsService,
    private readonly replyResponse: ReplyResponseBuilder,
  ) {}

  @Get('comments')
  @RequireCapability('inbox:view')
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
      q: query.q,
      sort: query.sort,
    });
  }

  /** Flat list of @mentions (account-level, not tied to a post/thread). */
  @Get('mentions')
  @RequireCapability('inbox:view')
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
      q: query.q,
      sort: query.sort,
    });
  }

  @Get('threads/:threadKey')
  @RequireCapability('inbox:view')
  async getThread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getThread(workspaceId, user.userId, threadKey);
  }

  @Post('comments/:itemId/reply')
  @RequireCapability('inbox:reply')
  async reply(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ReplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    // UNION during cutover: the legacy node fields plus `node` and `row`.
    const sent = await this.inboxService.reply(
      workspaceId,
      user.userId,
      itemId,
      dto.text,
      toSendOptions(dto),
    );
    return {
      ...sent,
      ...(await this.replyResponse.forComment(workspaceId, user.userId, sent)),
    };
  }

  @Post('threads/:threadKey/comments')
  @RequireCapability('inbox:reply')
  async commentOnPost(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: ReplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    // markDone does not apply to a new top-level comment.
    const sent = await this.inboxService.commentOnPost(
      workspaceId,
      user.userId,
      threadKey,
      dto.text,
    );
    return {
      ...sent,
      ...(await this.replyResponse.forComment(workspaceId, user.userId, sent)),
    };
  }

  @Patch('comments/:itemId/status')
  @RequireCapability('inbox:reply')
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
   * Legacy route for hiding a reply. It delegates to the same service as
   * `POST comments/:itemId/hide`, so the platform matrix is enforced the same
   * way; the body is the old `{ success, isHidden }` plus the new `node`.
   */
  @Patch('comments/:itemId/hide')
  @RequireCapability('inbox:reply')
  async hide(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: HideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.commentActions.hide(
      workspaceId,
      itemId,
      user.userId,
      dto.hidden,
    );
  }

  @Patch('threads/:threadKey/status')
  @RequireCapability('inbox:reply')
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
  @RequireCapability('inbox:view')
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
  @RequireCapability('inbox:view')
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
  @RequireCapability('inbox:reply')
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
  @RequireCapability('inbox:view')
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
  @RequireCapability('inbox:view')
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
      q: query.q,
      sort: query.sort,
    });
  }

  @Get('dms/:threadKey')
  @RequireCapability('inbox:view')
  async getDmThread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.getDmThread(workspaceId, user.userId, threadKey);
  }

  @Post('dms/:threadKey/messages')
  @RequireCapability('inbox:reply')
  async sendDm(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: SendDmDto,
    @CurrentUser() user: AuthUser,
  ) {
    const sent = await this.inboxService.sendDm(
      workspaceId,
      user.userId,
      threadKey,
      dto.text,
      dto.attachments?.map((a) => ({
        kind: a.kind === 'voice' ? 'audio' : a.kind,
        url: a.url,
        contentType: a.contentType,
      })),
      toSendOptions(dto),
    );
    return {
      ...sent,
      ...(await this.replyResponse.forDm(workspaceId, user.userId, sent)),
    };
  }

  @Post('dms/:threadKey/template')
  @RequireCapability('inbox:reply')
  async sendDmTemplate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @Body() dto: SendDmTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    const sent = await this.inboxService.sendDmTemplate(
      workspaceId,
      user.userId,
      threadKey,
      dto.name,
      dto.language,
      toSendOptions(dto),
    );
    return {
      ...sent,
      ...(await this.replyResponse.forDm(workspaceId, user.userId, sent)),
    };
  }

  @Post('dms/:threadKey/read')
  @RequireCapability('inbox:view')
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
  @RequireCapability('inbox:view')
  async listScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListScheduledMessagesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.list(workspaceId, user.userId, query);
  }

  @Get('scheduled/counts')
  @RequireCapability('inbox:view')
  async scheduledCounts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.counts(workspaceId, user.userId);
  }

  @Post('scheduled')
  @RequireCapability('inbox:reply')
  async createScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateScheduledMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.create(workspaceId, user.userId, dto);
  }

  @Get('scheduled/:id')
  @RequireCapability('inbox:view')
  async getScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.get(workspaceId, user.userId, id);
  }

  @Patch('scheduled/:id')
  @RequireCapability('inbox:reply')
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
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async cancelScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.cancel(workspaceId, user.userId, id);
  }

  @Post('scheduled/:id/send-now')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async sendNow(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.sendNow(workspaceId, user.userId, id);
  }

  @Post('scheduled/:id/restore')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async restoreScheduled(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduledMessagesService.restore(workspaceId, user.userId, id);
  }

  // ==========================================================================
  // Media uploads (Phase 2.3) — presigned PUT URL for inbox DM attachments.
  // Browser uploads directly to Cloudflare R2; backend never touches bytes.
  // ==========================================================================

  @Post('uploads/presign')
  @RequireCapability('inbox:reply')
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

  // `DELETE comments/:itemId` lives in CommentActionsController now.

  @Delete('dms/:itemId')
  @RequireCapability('inbox:reply')
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
  @RequireCapability('inbox:reply')
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
  @RequireCapability('inbox:reply')
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
