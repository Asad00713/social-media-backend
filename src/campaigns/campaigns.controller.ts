import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CampaignsService } from './campaigns.service';
import {
  CreateSimpleCampaignDto,
  CreateDripCampaignDto,
  UpdateCampaignDto,
  ListCampaignsQueryDto,
  AddDayDto,
  SetDaySkipDto,
  AddEventDto,
  UpdateEventDto,
  RemoveEventDto,
  AiEventDto,
} from './dto/campaigns.dto';

@Controller('campaigns')
@UseGuards(JwtAuthGuard)
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  // ==========================================================================
  // Read
  // ==========================================================================

  // NOTE: `status-counts` MUST be declared before the `:id` route below, or
  // Nest will match "status-counts" as an `:id` param value.
  @Get('workspaces/:workspaceId/status-counts')
  async statusCounts(@Param('workspaceId') workspaceId: string) {
    return this.campaignsService.statusCounts(workspaceId);
  }

  @Get('workspaces/:workspaceId')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListCampaignsQueryDto,
  ) {
    return this.campaignsService.list(workspaceId, {
      status: query.status && query.status !== 'all' ? query.status : undefined,
      search: query.search,
    });
  }

  @Get('workspaces/:workspaceId/:id')
  async getOne(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.campaignsService.getOne(workspaceId, id);
  }

  // ==========================================================================
  // Write — CRUD
  // ==========================================================================

  @Post('workspaces/:workspaceId')
  @HttpCode(HttpStatus.CREATED)
  async createSimple(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateSimpleCampaignDto,
  ) {
    return this.campaignsService.createSimple(workspaceId, user.userId, dto);
  }

  @Post('workspaces/:workspaceId/drip')
  @HttpCode(HttpStatus.CREATED)
  async createDrip(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateDripCampaignDto,
  ) {
    return this.campaignsService.createDrip(workspaceId, user.userId, dto);
  }

  @Patch('workspaces/:workspaceId/:id')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaignsService.update(workspaceId, id, dto);
  }

  @Delete('workspaces/:workspaceId/:id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    await this.campaignsService.remove(workspaceId, id);
    return { message: 'Campaign deleted successfully' };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  @Post('workspaces/:workspaceId/:id/launch')
  @HttpCode(HttpStatus.OK)
  async launch(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.campaignsService.launch(workspaceId, id);
  }

  @Post('workspaces/:workspaceId/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.campaignsService.pause(workspaceId, id);
  }

  @Post('workspaces/:workspaceId/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.campaignsService.resume(workspaceId, id);
  }

  @Post('workspaces/:workspaceId/:id/duplicate')
  @HttpCode(HttpStatus.OK)
  async duplicate(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.campaignsService.duplicate(workspaceId, user.userId, id);
  }

  // ==========================================================================
  // Days
  // ==========================================================================

  @Post('workspaces/:workspaceId/:id/days')
  @HttpCode(HttpStatus.OK)
  async addDay(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AddDayDto,
  ) {
    return this.campaignsService.addDay(workspaceId, id, dto.date);
  }

  @Delete('workspaces/:workspaceId/:id/days/:date')
  @HttpCode(HttpStatus.OK)
  async removeDay(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('date') date: string,
  ) {
    return this.campaignsService.removeDay(workspaceId, id, date);
  }

  @Patch('workspaces/:workspaceId/:id/days/:date')
  async setDaySkip(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('date') date: string,
    @Body() dto: SetDaySkipDto,
  ) {
    return this.campaignsService.setDaySkip(workspaceId, id, date, dto.skip);
  }

  // ==========================================================================
  // Events (slots)
  // ==========================================================================

  @Post('workspaces/:workspaceId/:id/events')
  @HttpCode(HttpStatus.OK)
  async addEvent(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AddEventDto,
  ) {
    return this.campaignsService.addEvent(workspaceId, id, dto);
  }

  @Patch('workspaces/:workspaceId/:id/events')
  async updateEvent(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.campaignsService.updateEvent(workspaceId, id, dto);
  }

  @Delete('workspaces/:workspaceId/:id/events')
  @HttpCode(HttpStatus.OK)
  async removeEvent(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: RemoveEventDto,
  ) {
    return this.campaignsService.removeEvent(workspaceId, id, dto);
  }

  // ==========================================================================
  // AI mock (Phase 1)
  // ==========================================================================

  @Post('workspaces/:workspaceId/:id/events/ai/generate')
  @HttpCode(HttpStatus.OK)
  async generateAi(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AiEventDto,
  ) {
    return this.campaignsService.generateAi(
      workspaceId,
      id,
      dto.date,
      dto.channelId,
    );
  }

  @Post('workspaces/:workspaceId/:id/events/ai/approve')
  @HttpCode(HttpStatus.OK)
  async approveAi(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AiEventDto,
  ) {
    return this.campaignsService.approveAi(
      workspaceId,
      id,
      dto.date,
      dto.channelId,
    );
  }

  @Post('workspaces/:workspaceId/:id/events/ai/skip')
  @HttpCode(HttpStatus.OK)
  async skipAi(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AiEventDto,
  ) {
    return this.campaignsService.skipAi(
      workspaceId,
      id,
      dto.date,
      dto.channelId,
    );
  }
}
