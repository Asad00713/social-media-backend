import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './services/analytics.service';
import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';

@Controller('channels/workspaces/:wsId/:channelId')
@UseGuards(AuthGuard('jwt'), WorkspaceRoleGuard, ChannelOwnershipGuard)
// A refresh spends the per-channel and per-workspace refresh quota (and a call
// on the platform's API), which is shared by the whole team, so it needs the
// same right as the other channel operations. Reading the numbers stays on
// analytics:view.
@RequireCapability('channels:manage')
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
