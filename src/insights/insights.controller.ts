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
import type {
  InsightsOverviewDto,
  InsightsPostsDto,
  PostChannelMetricsDto,
} from './dto/insights.dto';
import { utcToday } from '../post-performance/period';
import { InsightsService } from './insights.service';
import {
  parseCompare,
  parsePeriod,
  parsePostIds,
  parseTableQuery,
  parseTz,
  single,
} from './lib/query';

/** `days=7|30|90` or `from&to`, against today's UTC date. */
const periodOf = (days?: string, from?: string, to?: string) =>
  parsePeriod({ days, from, to }, utcToday(new Date()));

@Controller('insights/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('analytics:view')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** Everything above the content table, for a preset or a picked range. */
  @Get('overview')
  overview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('compare') compare?: string,
    @Query('channels') channels?: string | string[],
    @Query('tz') tz?: string,
  ): Promise<InsightsOverviewDto> {
    return this.insights.overview(
      workspaceId,
      periodOf(days, from, to),
      single(channels, 'channels'),
      parseTz(tz),
      parseCompare(compare),
    );
  }

  /** The "All content" table, a page at a time. */
  @Get('posts')
  posts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channels') channels?: string | string[],
    @Query('format') format?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<InsightsPostsDto> {
    return this.insights.posts(
      workspaceId,
      periodOf(days, from, to),
      single(channels, 'channels'),
      parseTableQuery({ format, sort, order, limit, offset }),
    );
  }

  /** Latest numbers for up to 50 posts, per channel, against its usual. */
  @Get('posts/metrics')
  async metrics(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('postIds') postIds?: string | string[],
  ): Promise<{ metrics: PostChannelMetricsDto[] }> {
    return {
      metrics: await this.insights.postMetrics(
        workspaceId,
        parsePostIds(single(postIds, 'postIds')),
      ),
    };
  }

  /** The same table, every row, as a CSV download. */
  @Get('posts/export')
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channels') channels?: string | string[],
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
      periodOf(days, from, to),
      single(channels, 'channels'),
      { format: f, sort: s, order: o },
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }
}
