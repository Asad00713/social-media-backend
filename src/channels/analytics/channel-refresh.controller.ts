import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './services/analytics.service';
import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';

@Controller('channels/workspaces/:wsId/:channelId')
@UseGuards(AuthGuard('jwt'), ChannelOwnershipGuard)
export class ChannelRefreshController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('refresh')
  async refresh(
    @Param('wsId') wsId: string,
    @Param('channelId') channelIdParam: string,
  ) {
    return this.analytics.requestManualRefresh(Number(channelIdParam), wsId);
  }
}
