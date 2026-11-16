import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { ConnectLinksService } from './connect-links.service';
import {
  CreateConnectLinkDto,
  type ConnectLinkDto,
  type ConnectLinkResponse,
  type ConnectLinkWithUrlResponse,
} from './dto/connect-link.dto';

/**
 * The sender side of connect links ("Ask someone to connect"). Everything here
 * needs `channels:manage`, the same capability as connecting a channel; a
 * `:linkId` of another workspace is a 404.
 *
 * Shares the `channels/workspaces/:workspaceId` prefix with ChannelsController,
 * whose `GET workspaces/:workspaceId/:channelId` would read `connect-links` as
 * a channel id. ChannelsModule lists this controller BEFORE it.
 */
@Controller('channels/workspaces/:workspaceId/connect-links')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('channels:manage')
export class ConnectLinksController {
  constructor(private readonly links: ConnectLinksService) {}

  @Post()
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateConnectLinkDto,
  ): Promise<ConnectLinkWithUrlResponse> {
    return this.links.create(workspaceId, user.userId, dto);
  }

  /** Open links, newest first. */
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<ConnectLinkDto[]> {
    return this.links.list(workspaceId);
  }

  /** One link with its URL: Copy link on an existing link. */
  @Get(':linkId')
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<ConnectLinkWithUrlResponse> {
    return this.links.get(workspaceId, linkId);
  }

  @Post(':linkId/resend')
  @HttpCode(HttpStatus.OK)
  async resend(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<ConnectLinkResponse> {
    return this.links.resend(workspaceId, linkId);
  }

  @Post(':linkId/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<ConnectLinkResponse> {
    return this.links.revoke(workspaceId, linkId);
  }
}
