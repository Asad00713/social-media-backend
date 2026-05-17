import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels, type SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { AnalyticsService, type AnalyticsRange } from './services/analytics.service';
import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';
import { OverviewResponseDto } from './dto/overview-response.dto';

const VALID_RANGES: AnalyticsRange[] = ['7d', '30d', 'mtd', 'lm', 'custom'];

@Controller('analytics/workspaces/:wsId/channels/:channelId')
@UseGuards(AuthGuard('jwt'), ChannelOwnershipGuard)
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  @Get('overview')
  async getOverview(
    @Param('wsId') _wsId: string,
    @Param('channelId') channelIdParam: string,
    @Query('range') range: AnalyticsRange = '30d',
  ): Promise<OverviewResponseDto> {
    if (!VALID_RANGES.includes(range)) {
      throw new BadRequestException(`Invalid range. Must be one of: ${VALID_RANGES.join(', ')}`);
    }
    const channelId = Number(channelIdParam);
    const rows = await this.db
      .select({ platform: socialMediaChannels.platform })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);

    if (!rows[0]) throw new BadRequestException('Channel not found');

    return this.analytics.getOverview(
      channelId,
      rows[0].platform as SupportedPlatform,
      range,
    );
  }

  @Get('sync-state')
  async getSyncState(
    @Param('wsId') _wsId: string,
    @Param('channelId') channelIdParam: string,
  ) {
    return this.analytics.getSyncState(Number(channelIdParam));
  }
}
