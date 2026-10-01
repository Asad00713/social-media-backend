import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import type { InsightsOverviewDto, InsightsPostsDto } from './dto/insights.dto';
import { InsightsService } from './insights.service';
import { parseDays, parseTableQuery, parseTz } from './lib/query';

@Controller('insights/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('analytics:view')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** Everything above the content table, for 7, 30 or 90 days. */
  @Get('overview')
  overview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('tz') tz?: string,
  ): Promise<InsightsOverviewDto> {
    return this.insights.overview(
      workspaceId,
      parseDays(days),
      channels,
      parseTz(tz),
    );
  }

  /** The "All content" table, a page at a time. */
  @Get('posts')
  posts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('format') format?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<InsightsPostsDto> {
    return this.insights.posts(
      workspaceId,
      parseDays(days),
      channels,
      parseTableQuery({ format, sort, order, limit, offset }),
    );
  }

  /** The same table, every row, as a CSV download. */
  @Get('posts/export')
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('format') format?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ): Promise<string> {
    const {
      format: f,
      sort: s,
      order: o,
    } = parseTableQuery({ format, sort, order });
    const { filename, body } = await this.insights.csv(
      workspaceId,
      parseDays(days),
      channels,
      { format: f, sort: s, order: o },
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }
}
