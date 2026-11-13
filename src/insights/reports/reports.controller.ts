import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import {
  CreateReportDto,
  PreviewReportDto,
  ShareReportDto,
  UpdateReportDto,
} from './dto/report-settings.dto';
import type { ReportDto, ReportPayloadDto } from './reports.dto';
import { ReportsService } from './reports.service';

/**
 * Saved Insights reports. Anyone who can see Insights can read them; creating,
 * changing, sharing and deleting one is `reports:manage`, because a report
 * emails people outside the workspace.
 */
@Controller('insights/workspaces/:workspaceId/reports')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('analytics:view')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<ReportDto[]> {
    return this.reports.list(workspaceId);
  }

  // Declared before the `:id` routes so `preview` is never read as an id.
  @Post('preview')
  @HttpCode(200)
  preview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: PreviewReportDto,
  ): Promise<ReportPayloadDto> {
    return this.reports.preview(workspaceId, dto);
  }

  @Get(':id')
  get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportDto> {
    return this.reports.get(workspaceId, id);
  }

  @Get(':id/pdf')
  async pdf(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { filename, body } = await this.reports.pdf(workspaceId, id);
    return new StreamableFile(body, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post()
  @RequireCapability('reports:manage')
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateReportDto,
  ): Promise<ReportDto> {
    return this.reports.create(workspaceId, user.userId, dto);
  }

  @Patch(':id')
  @RequireCapability('reports:manage')
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateReportDto,
  ): Promise<ReportDto> {
    return this.reports.update(workspaceId, user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireCapability('reports:manage')
  remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.reports.remove(workspaceId, id);
  }

  @Post(':id/share')
  @HttpCode(200)
  @RequireCapability('reports:manage')
  share(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ShareReportDto,
  ): Promise<{ url: string | null }> {
    return this.reports.setShare(workspaceId, user.userId, id, dto.enabled);
  }

  /** Queues a send to the schedule's people; the next scheduled send stays. */
  @Post(':id/send')
  @HttpCode(202)
  @RequireCapability('reports:manage')
  send(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ recipients: number }> {
    return this.reports.sendNow(workspaceId, id);
  }
}
