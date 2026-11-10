import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentWorkspaceRole } from '../../workspace-members/current-workspace-role.decorator';
import type { CallerRole } from '../guest-rules';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PublishOrchestratorService } from './services/publish-orchestrator.service';
import { DraftStoreService } from './services/draft-store.service';
import { DraftVersionsService } from './services/draft-versions.service';
import { ComposerSchedulingService } from './services/composer-scheduling.service';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { ScheduleDraftDto } from './dto/schedule-draft.dto';
import { SetApprovalDto } from './dto/set-approval.dto';
import { DraftApprovalService } from './services/draft-approval.service';
import { LinkPreviewService } from './services/link-preview.service';
import { LinkPreviewQueryDto } from './dto/link-preview.dto';

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
    private readonly versions: DraftVersionsService,
    private readonly approvals: DraftApprovalService,
    private readonly linkPreviews: LinkPreviewService,
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

  /** Saved versions of a post, newest first (at most 50). */
  @RequireCapability('posts:draft')
  @Get('drafts/:draftId/versions')
  async listVersions(
    @Param('wsId') wsId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ) {
    return this.versions.list(wsId, draftId);
  }

  /** Write a saved version back as a new save. Drafts only (409 otherwise). */
  @RequireCapability('posts:draft')
  @Post('drafts/:draftId/versions/:versionId/restore')
  async restoreVersion(
    @Param('wsId') wsId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ) {
    return this.drafts.restoreVersion(
      wsId,
      draftId,
      versionId,
      user.userId,
      role,
    );
  }

  /** "Needs approval": the draft's approval state, for the caller. */
  @RequireCapability('posts:draft')
  @Get('drafts/:draftId/approval')
  async getApproval(
    @Param('wsId', ParseUUIDPipe) wsId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ) {
    return this.approvals.get(wsId, draftId, user.userId, role);
  }

  /**
   * Switch "Needs approval" on (anyone who may draft; approvers are told) or
   * off (approvers only). The draft must be saved first.
   */
  @RequireCapability('posts:draft')
  @Put('drafts/:draftId/approval')
  async setApproval(
    @Param('wsId', ParseUUIDPipe) wsId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: SetApprovalDto,
  ) {
    return this.approvals.setRequired(
      wsId,
      draftId,
      user.userId,
      role,
      dto.required,
    );
  }

  /** Approve the draft as it is stored now. ADMIN and OWNER. */
  @RequireCapability('posts:approve')
  @Post('drafts/:draftId/approval/approve')
  @HttpCode(HttpStatus.OK)
  async approveDraft(
    @Param('wsId', ParseUUIDPipe) wsId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ) {
    return this.approvals.approve(wsId, draftId, user.userId, role);
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
      campaignId: dto.campaignId,
      labels: dto.labels,
    });
  }

  /** Every label used in this workspace, for the composer's Labels picker. */
  @RequireCapability('posts:draft')
  @Get('labels')
  async listLabels(@Param('wsId') wsId: string) {
    return { labels: await this.drafts.listLabels(wsId) };
  }

  /**
   * A page's title, description and image, for prefilling a Facebook
   * carousel card. Public https pages only (SSRF-safe reader); 200 with
   * `isReadable: false` when the page cannot be read. Throttled: each call
   * makes this server fetch a page, so it is capped at 60 a minute - an
   * editor reads at most five cards.
   */
  @RequireCapability('posts:draft')
  @Get('link-preview')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async linkPreview(@Query() query: LinkPreviewQueryDto) {
    return this.linkPreviews.preview(query.url);
  }
}
