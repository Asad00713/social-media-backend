import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './services/analytics.service';
import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';

@Controller('channels/workspaces/:wsId/:channelId')
@UseGuards(AuthGuard('jwt'), WorkspaceRoleGuard, ChannelOwnershipGuard)
// A refresh only re-reads data a viewer can already see, and it is capped per
// channel and per workspace, so viewing rights are enough.
@RequireCapability('analytics:view')
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
