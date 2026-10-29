import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { BulkConversationsDto } from './dto/bulk.dto';
import type {
  BulkResult,
  ConversationRow,
  InboxCounts,
  ListConversationsResponse,
  MutationResult,
} from './dto/contract';
import { PatchConversationDto } from './dto/patch-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.query';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationMutationsService } from './services/conversation-mutations.service';
import { ConversationPresenter } from './services/conversation-presenter.service';

@Controller('inbox/workspaces/:workspaceId/conversations')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ConversationsController {
  constructor(
    private readonly listService: ConversationListService,
    private readonly presenter: ConversationPresenter,
    private readonly mutations: ConversationMutationsService,
  ) {}

  @RequireCapability('inbox:view')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Query() query: ListConversationsQueryDto,
  ): Promise<ListConversationsResponse> {
    return await this.listService.list(workspaceId, user.userId, query);
  }

  // Keep `counts` declared BEFORE any `:id` route (Task 12b adds them) so it is never read as an id.
  @RequireCapability('inbox:view')
  @Get('counts')
  async counts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<InboxCounts> {
    return await this.presenter.counts(workspaceId);
  }

  @RequireCapability('inbox:reply')
  @HttpCode(200)
  @Post('bulk')
  async bulk(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() body: BulkConversationsDto,
  ): Promise<BulkResult> {
    return await this.mutations.bulk(workspaceId, user.userId, body);
  }

  @RequireCapability('inbox:reply')
  @Patch(':id')
  async patch(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Body() body: PatchConversationDto,
  ): Promise<MutationResult> {
    return await this.mutations.patch(workspaceId, id, user.userId, body);
  }

  // Read state is shared (D4): a GUEST may open a conversation.
  @RequireCapability('inbox:view')
  @HttpCode(200)
  @Post(':id/read')
  async read(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ row: ConversationRow }> {
    return await this.mutations.markRead(workspaceId, id);
  }

  @RequireCapability('inbox:reply')
  @HttpCode(200)
  @Post(':id/unread')
  async unread(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
  ): Promise<MutationResult> {
    return await this.mutations.markUnread(workspaceId, id, user.userId);
  }

  @RequireCapability('inbox:reply')
  @HttpCode(200)
  @Delete(':id')
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    return await this.mutations.remove(workspaceId, id);
  }

  @RequireCapability('inbox:reply')
  @HttpCode(200)
  @Post(':id/restore')
  async restore(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ row: ConversationRow }> {
    return await this.mutations.restore(workspaceId, id);
  }
}
