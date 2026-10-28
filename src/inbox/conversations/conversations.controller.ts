import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import type { InboxCounts, ListConversationsResponse } from './dto/contract';
import { ListConversationsQueryDto } from './dto/list-conversations.query';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationPresenter } from './services/conversation-presenter.service';

@Controller('inbox/workspaces/:workspaceId/conversations')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ConversationsController {
  constructor(
    private readonly list_: ConversationListService,
    private readonly presenter: ConversationPresenter,
  ) {}

  @RequireCapability('inbox:view')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Query() query: ListConversationsQueryDto,
  ): Promise<ListConversationsResponse> {
    return await this.list_.list(workspaceId, user.userId, query);
  }

  // Declared before any `:id` route so "counts" is never read as an id.
  @RequireCapability('inbox:view')
  @Get('counts')
  async counts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<InboxCounts> {
    return await this.presenter.counts(workspaceId);
  }
}
