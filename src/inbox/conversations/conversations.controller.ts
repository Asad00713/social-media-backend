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
import { CurrentWorkspaceRole } from '../../workspace-members/current-workspace-role.decorator';
import type { WorkspaceRole } from '../../workspace-members/role-capabilities';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { mayChangeReadState } from '../read-state-access';
import { BulkConversationsDto } from './dto/bulk.dto';
import type {
  BulkResult,
  ConversationDetail,
  ConversationRow,
  InboxCounts,
  ListConversationsResponse,
  MutationResult,
  ProfileStats,
} from './dto/contract';
import { PatchConversationDto } from './dto/patch-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.query';
import { ConversationDetailService } from './services/conversation-detail.service';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationMutationsService } from './services/conversation-mutations.service';
import { ConversationPresenter } from './services/conversation-presenter.service';
import { PlanFeatureGuard } from '../../billing/plan/plan-feature.guard';
import { RequiresFeature } from '../../billing/plan/requires-feature.decorator';

@Controller('inbox/workspaces/:workspaceId/conversations')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard, PlanFeatureGuard)
@RequiresFeature('inbox:use')
export class ConversationsController {
  constructor(
    private readonly listService: ConversationListService,
    private readonly presenter: ConversationPresenter,
    private readonly mutations: ConversationMutationsService,
    private readonly detail: ConversationDetailService,
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

  // Keep `counts` and `by-key/:threadKey` declared BEFORE any `:id` route so they are never read as an id.
  @RequireCapability('inbox:view')
  @Get('counts')
  async counts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<InboxCounts> {
    return await this.presenter.counts(workspaceId);
  }

  // The client URL-encodes the key (it may hold `:` and `/`, e.g. Bluesky at:// URIs);
  // Express hands it to us decoded.
  @RequireCapability('inbox:view')
  @Get('by-key/:threadKey')
  async byKey(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('threadKey') threadKey: string,
    @CurrentUser() user: { userId: string },
  ): Promise<ConversationDetail> {
    return await this.detail.getDetailByKey(
      workspaceId,
      threadKey,
      user.userId,
    );
  }

  @RequireCapability('inbox:view')
  @Get(':id')
  async getDetail(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
  ): Promise<ConversationDetail> {
    return await this.detail.getDetail(workspaceId, id, user.userId);
  }

  @RequireCapability('inbox:view')
  @Get(':id/profile')
  async profile(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProfileStats> {
    return await this.detail.getProfile(workspaceId, id);
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

  // Read state is shared (D4): a GUEST may open a conversation, but opening it
  // must not clear the unread badge for the team, so a role without
  // inbox:reply gets the row back unchanged.
  @RequireCapability('inbox:view')
  @HttpCode(200)
  @Post(':id/read')
  async read(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentWorkspaceRole() role?: WorkspaceRole | 'SUPER_ADMIN',
  ): Promise<{ row: ConversationRow }> {
    if (!mayChangeReadState(role)) {
      return { row: await this.mutations.peekRow(workspaceId, id) };
    }
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
