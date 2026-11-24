import { SubscriptionLookupService } from '../billing/services/subscription-lookup.service';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { PlanFeatureGuard } from '../billing/plan/plan-feature.guard';
import { RequiresFeature } from '../billing/plan/requires-feature.decorator';
import type {
  InsightsOverviewDto,
  InsightsPostsDto,
  PostChannelMetricsDto,
  PostDetailDto,
} from './dto/insights.dto';
import type { InsightsSignalsDto } from './dto/insights.dto';
import { HideStepDto } from './dto/hide-step.dto';
import { InsightsService } from './insights.service';
import { STEP_ID_PATTERN } from './lib/next-steps';
import {
  parseCompare,
  parsePostIds,
  parseTableQuery,
  parseTz,
  periodOf,
  single,
  clampHistory,
  type ResolvedPeriod,
} from './lib/query';

/**
 * A query param as Express hands it over: a repeated one is an array. Every
 * param goes through `single` so a repeat is a 400, never a crash.
 */
type Raw = string | string[];

/** The table's own params, each exactly once. */
const tableOf = (raw: {
  format?: Raw;
  sort?: Raw;
  order?: Raw;
  limit?: Raw;
  offset?: Raw;
}) =>
  parseTableQuery({
    format: single(raw.format, 'format'),
    sort: single(raw.sort, 'sort'),
    order: single(raw.order, 'order'),
    limit: single(raw.limit, 'limit'),
    offset: single(raw.offset, 'offset'),
  });

@Controller('insights/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard, PlanFeatureGuard)
@RequireCapability('analytics:view')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    // New parameters go LAST: existing specs construct this positionally.
    private readonly lookup: SubscriptionLookupService,
  ) {}
  /**
   * The window the caller asked for, shortened to the history their plan
   * includes.
   *
   * Every read on this controller goes through here, so the plan's depth is
   * applied in one place rather than seven. `clampHistory` returns the window
   * untouched for a plan that allows it, so the paid path costs one extra
   * lookup and no change in behaviour.
   */
  private async period(
    workspaceId: string,
    days?: Raw,
    from?: Raw,
    to?: Raw,
  ): Promise<{ period: ResolvedPeriod; limitedTo: number | null }> {
    const historyDays = await this.lookup.getInsightsHistoryDays(workspaceId);
    // `limitedTo` is kept OUT of the period the services receive: they take a
    // window, and have no business knowing why it is the length it is. It is
    // returned alongside so `overview` can put it in the response, where the
    // UI needs it to explain a short window — and so the plan is looked up
    // once per request rather than twice.
    const { limitedTo, ...period } = clampHistory(
      periodOf(days, from, to),
      historyDays,
    );
    return { period, limitedTo };
  }


  /** Everything above the content table, for a preset or a picked range. */
  @Get('overview')
  async overview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('compare') compare?: Raw,
    @Query('channels') channels?: Raw,
    @Query('tz') tz?: Raw,
  ): Promise<InsightsOverviewDto> {
    const { period, limitedTo } = await this.period(
      workspaceId,
      days,
      from,
      to,
    );
    const dto = await this.insights.overview(
      workspaceId,
      period,
      single(channels, 'channels'),
      parseTz(single(tz, 'tz')),
      parseCompare(single(compare, 'compare')),
    );
    // Only present when something was actually shortened, so a paid plan's
    // response is byte-for-byte what it was before this existed.
    return limitedTo === null ? dto : { ...dto, historyLimitedTo: limitedTo };
  }

  /** The "All content" table, a page at a time. */
  @Get('posts')
  async posts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
    @Query('format') format?: Raw,
    @Query('sort') sort?: Raw,
    @Query('order') order?: Raw,
    @Query('limit') limit?: Raw,
    @Query('offset') offset?: Raw,
  ): Promise<InsightsPostsDto> {
    return this.insights.posts(
      workspaceId,
      (await this.period(workspaceId, days, from, to)).period,
      single(channels, 'channels'),
      tableOf({ format, sort, order, limit, offset }),
    );
  }

  /** Latest numbers for up to 50 posts, per channel, against its usual. */
  @Get('posts/metrics')
  async metrics(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('postIds') postIds?: Raw,
  ): Promise<{ metrics: PostChannelMetricsDto[] }> {
    return {
      metrics: await this.insights.postMetrics(
        workspaceId,
        parsePostIds(single(postIds, 'postIds')),
      ),
    };
  }

  /** The same table, every row, as a CSV download. */
  //
  // Gated per route, not on the class: the matrix keeps Insights itself on
  // Free (with a shorter history window) and puts only the EXPORT behind Pro.
  // A class-level gate here would take analytics away from Free entirely.
  @RequiresFeature('insights:export')
  @Get('posts/export')
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
    @Query('format') format?: Raw,
    @Query('sort') sort?: Raw,
    @Query('order') order?: Raw,
  ): Promise<string> {
    const { format: f, sort: s, order: o } = tableOf({ format, sort, order });
    const { filename, body } = await this.insights.csv(
      workspaceId,
      (await this.period(workspaceId, days, from, to)).period,
      single(channels, 'channels'),
      { format: f, sort: s, order: o },
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /**
   * The window's day totals as a CSV, one row per day (the channel page's
   * Export). `kind=daily` is the only kind; the posts table has its own
   * `posts/export`.
   */
  @RequiresFeature('insights:export')
  @Get('export')
  async exportDaily(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('kind') kind?: Raw,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
  ): Promise<string> {
    const k = single(kind, 'kind');
    if (k !== undefined && k !== '' && k !== 'daily') {
      throw new BadRequestException('kind must be daily');
    }
    const { filename, body } = await this.insights.dailyCsv(
      workspaceId,
      (await this.period(workspaceId, days, from, to)).period,
      single(channels, 'channels'),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** Best time, What works and Next steps over the last 90 days. */
  @Get('signals')
  async signals(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Query('channels') channels?: Raw,
  ): Promise<InsightsSignalsDto> {
    return this.insights.signals(
      workspaceId,
      user.userId,
      single(channels, 'channels'),
    );
  }

  /**
   * Hides one next step for the signed-in person, in this workspace only:
   * `not_useful` for 180 days, `later` for 30. Anyone who can see Insights
   * can hide a card; it is theirs alone.
   */
  @Post('next-steps/:id/hide')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hideStep(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: HideStepDto,
  ): Promise<void> {
    if (!STEP_ID_PATTERN.test(id)) {
      throw new BadRequestException('Not a next step id');
    }
    await this.insights.hideStep(workspaceId, user.userId, id, dto.reason);
  }

  /** One post on one channel: tiles, verdict, reasons and its first 48 hours. */
  @Get('posts/:postId/channels/:channelId')
  async postDetail(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
  ): Promise<PostDetailDto> {
    return this.insights.postDetail(workspaceId, postId, channelId);
  }
}
