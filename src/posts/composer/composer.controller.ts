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
@UseGuards(JwtAuthGuard)
export class ComposerController {
  constructor(
    private readonly orchestrator: PublishOrchestratorService,
    private readonly drafts: DraftStoreService,
    private readonly scheduling: ComposerSchedulingService,
  ) {}

  @Put('drafts')
  async saveDraft(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: SaveDraftDto,
  ) {
    return this.drafts.upsert(wsId, user.userId, dto);
  }

  @Get('drafts')
  async listDrafts(
    @Param('wsId') wsId: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? Number(limitStr) : 50;
    return this.drafts.listDrafts(wsId, limit);
  }

  @Get('drafts/:draftId')
  async getDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.drafts.findById(wsId, draftId);
  }

  @Delete('drafts/:draftId')
  async deleteDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.drafts.delete(wsId, draftId);
  }

  @Post('schedule')
  async schedule(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ScheduleDraftDto,
  ) {
    return this.scheduling.schedule(wsId, user.userId, dto);
  }

  @Delete('schedule/:draftId')
  async cancelSchedule(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.scheduling.cancel(wsId, draftId);
  }

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
