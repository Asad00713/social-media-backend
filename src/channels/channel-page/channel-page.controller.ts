import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import {
  ChannelPostsQueryDto,
  type ChannelPageResponse,
  type ChannelPostsResponse,
} from './dto/channel-page.dto';
import { ChannelPageService } from './services/channel-page.service';
import { ChannelPostsService } from './services/channel-posts.service';

/**
 * The per-channel page (Figma Section 4): its Overview in one request and
 * its Posts tab. Anyone who can see the channels can read it; a channel of
 * another workspace is a 404.
 *
 * Shares the `channels/workspaces/:workspaceId` prefix with
 * ChannelsController and ChannelHubController. Its paths are
 * `:channelId/<literal>`, which no other route under that prefix can match
 * (channel-page.routes.spec.ts proves it), so module order does not matter.
 * It lives in its own module because it composes Insights, the Planner and
 * the Inbox, and PostsModule already imports ChannelsModule.
 */
@Controller('channels/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ChannelPageController {
  constructor(
    private readonly page: ChannelPageService,
    private readonly posts: ChannelPostsService,
  ) {}

  @RequireCapability('posts:draft')
  @Get(':channelId/page')
  async getPage(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
    @CurrentUser() user: { userId: string },
  ): Promise<ChannelPageResponse> {
    return this.page.getPage(workspaceId, channelId, user.userId);
  }

  @RequireCapability('posts:draft')
  @Get(':channelId/posts')
  async listPosts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
    @Query() query: ChannelPostsQueryDto,
  ): Promise<ChannelPostsResponse> {
    return this.posts.list(workspaceId, channelId, query);
  }
}
