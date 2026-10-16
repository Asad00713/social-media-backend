import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentWorkspaceRole } from '../../workspace-members/current-workspace-role.decorator';
import type { CallerRole } from '../guest-rules';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PublishOrchestratorService } from './services/publish-orchestrator.service';
import { DraftStoreService } from './services/draft-store.service';
import { ComposerSchedulingService } from './services/composer-scheduling.service';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { ScheduleDraftDto } from './dto/schedule-draft.dto';

/**
 * Composer endpoints. Three explicit user triggers — no autosave:
 *   - PUT  /drafts          → Save Draft (status='draft')
 *   - POST /publish         → Publish now (status='published'|'partial_success'|'failed')
 *   - POST /schedule (TODO) → Schedule for later (status='scheduled', BullMQ delayed)
 *
 * Plus read paths to power the Drafts list page.
 */
@Controller('composer/workspaces/:wsId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ComposerController {
  constructor(
    private readonly orchestrator: PublishOrchestratorService,
    private readonly drafts: DraftStoreService,
    private readonly scheduling: ComposerSchedulingService,
  ) {}

  @RequireCapability('posts:draft')
  @Put('drafts')
  async saveDraft(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: SaveDraftDto,
  ) {
    return this.drafts.upsert(wsId, user.userId, dto, role);
  }

  @RequireCapability('posts:draft')
  @Get('drafts')
  async listDrafts(
    @Param('wsId') wsId: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? Number(limitStr) : 50;
    return this.drafts.listDrafts(wsId, limit);
  }

  @RequireCapability('posts:draft')
  @Get('drafts/:draftId')
  async getDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.drafts.findById(wsId, draftId);
  }

  @RequireCapability('posts:draft')
  @Delete('drafts/:draftId')
  async deleteDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ) {
    return this.drafts.delete(wsId, draftId, user.userId, role);
  }

  @RequireCapability('posts:publish')
  @Post('schedule')
  async schedule(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ScheduleDraftDto,
  ) {
    return this.scheduling.schedule(wsId, user.userId, dto);
  }

  @RequireCapability('posts:publish')
  @Delete('schedule/:draftId')
  async cancelSchedule(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.scheduling.cancel(wsId, draftId);
  }

  @RequireCapability('posts:publish')
  @Post('publish')
  async publish(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: PublishDraftDto,
  ) {
    return this.orchestrator.publishInline(wsId, user.userId, {
      draftId: dto.draftId,
      base: dto.base,
      perPlatform: dto.perPlatform,
      channels: dto.channels,
      schedule: dto.schedule,
      retryChannelIds: dto.retryChannelIds,
    });
  }
}
