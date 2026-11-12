import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  CreateNetworkRequestDto,
  type ChannelsSummaryResponse,
  type NetworkRequestResponse,
  type PauseChannelResponse,
  type ResumeChannelResponse,
} from './dto/channel-hub.dto';
import { ChannelPauseService } from './services/channel-pause.service';
import { ChannelSummaryService } from './services/channel-summary.service';
import { NetworkRequestsService } from './services/network-requests.service';

/**
 * The redesigned Channels page: card summaries, the user's pause, and
 * "Request a network".
 *
 * Shares the `channels/workspaces/:workspaceId` prefix with ChannelsController,
 * whose `GET workspaces/:workspaceId/:channelId` would read `summary` as a
 * channel id. ChannelsModule lists this controller FIRST, so its routes are
 * registered (and matched) before that one - see channels.module.spec.ts.
 */
@Controller('channels/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ChannelHubController {
  constructor(
    private readonly summaries: ChannelSummaryService,
    private readonly pauses: ChannelPauseService,
    private readonly networkRequests: NetworkRequestsService,
  ) {}

  /** Every card's numbers in one request. Anyone who can see the channels. */
  @RequireCapability('posts:draft')
  @Get('summary')
  async summary(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<ChannelsSummaryResponse> {
    return this.summaries.getSummary(workspaceId);
  }

  /** Same capability as editing or disconnecting a channel. */
  @RequireCapability('channels:manage')
  @Post(':channelId/pause')
  @HttpCode(HttpStatus.OK)
  async pause(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
    @CurrentUser() user: { userId: string },
  ): Promise<PauseChannelResponse> {
    return this.pauses.pause(workspaceId, channelId, user.userId);
  }

  @RequireCapability('channels:manage')
  @Post(':channelId/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
  ): Promise<ResumeChannelResponse> {
    return this.pauses.resume(workspaceId, channelId);
  }

  /** Whoever can connect channels can ask for one we do not support yet. */
  @RequireCapability('channels:manage')
  @Post('network-requests')
  @HttpCode(HttpStatus.CREATED)
  async requestNetwork(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateNetworkRequestDto,
  ): Promise<NetworkRequestResponse> {
    return this.networkRequests.create(workspaceId, user.userId, dto);
  }
}
