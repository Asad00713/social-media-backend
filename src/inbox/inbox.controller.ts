import {
  Body,
  Controller,
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
import { ListCommentsDto } from './dto/list-comments.dto';
import { ReplyDto } from './dto/reply.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

interface AuthUser {
  userId: string;
  email: string;
}

@Controller('inbox/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

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
    return this.inboxService.markThreadRead(workspaceId, user.userId, threadKey);
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
}
