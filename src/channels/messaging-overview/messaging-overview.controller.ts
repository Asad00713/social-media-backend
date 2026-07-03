import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InboxService } from '../../inbox/inbox.service';
import { ChannelService } from '../services/channel.service';
import { MessagingOverviewService } from './messaging-overview.service';
import { MessagingOverviewResponseDto } from './dto/messaging-overview-response.dto';
import type { MessagingRange } from './messaging-overview.helpers';

interface AuthUser {
  userId: string;
  email: string;
}

const VALID_RANGES: MessagingRange[] = ['7d', '30d', '90d'];

@Controller('analytics/workspaces/:workspaceId/channels/:channelId')
@UseGuards(JwtAuthGuard)
export class MessagingOverviewController {
  constructor(
    private readonly service: MessagingOverviewService,
    private readonly channels: ChannelService,
    private readonly inbox: InboxService,
  ) {}

  @Get('messaging-overview')
  async getMessagingOverview(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelIdParam: string,
    @Query('range') range: MessagingRange = '30d',
    @CurrentUser() user: AuthUser,
  ): Promise<MessagingOverviewResponseDto> {
    if (!VALID_RANGES.includes(range)) {
      throw new BadRequestException(
        `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}`,
      );
    }
    // Workspace membership (JWT alone does not prove membership).
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, user.userId);

    const channelId = Number(channelIdParam);
    // Channel-in-workspace (throws 404 if not in this workspace).
    const channel = await this.channels.getChannelById(channelId, workspaceId);
    if (channel.platform !== 'slack') {
      throw new BadRequestException(
        'Messaging overview is only available for Slack channels',
      );
    }

    return this.service.getOverview(channelId, workspaceId, range);
  }
}
