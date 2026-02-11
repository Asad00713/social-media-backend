import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CommunityService } from './services/community.service';
import {
  GetPostRepliesDto,
  GetMentionsDto,
  GetAllCommentsDto,
  CreateReplyDto,
} from './dto/community.dto';

@Controller('community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  /**
   * Get replies/comments on a specific post
   * POST /community/workspaces/:workspaceId/comments
   */
  @Post('workspaces/:workspaceId/comments')
  @HttpCode(HttpStatus.OK)
  async getPostComments(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GetPostRepliesDto,
  ) {
    return this.communityService.getPostComments(
      dto.channelId,
      workspaceId,
      dto.postId,
      {
        paginationToken: dto.paginationToken,
        sinceId: dto.sinceId,
      },
    );
  }

  /**
   * Get full conversation thread: audience comments + owner's replies combined.
   * Best used with Twitter paid plans for complete thread view.
   * POST /community/workspaces/:workspaceId/comments/full
   */
  @Post('workspaces/:workspaceId/comments/full')
  @HttpCode(HttpStatus.OK)
  async getFullPostComments(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GetPostRepliesDto,
  ) {
    return this.communityService.getFullPostComments(
      dto.channelId,
      workspaceId,
      dto.postId,
      {
        paginationToken: dto.paginationToken,
        sinceId: dto.sinceId,
      },
    );
  }

  /**
   * Get all comments across recent posts for a channel (no postId needed).
   * Fetches recent posts, then retrieves comments for each post with replies.
   * POST /community/workspaces/:workspaceId/comments/all
   */
  @Post('workspaces/:workspaceId/comments/all')
  @HttpCode(HttpStatus.OK)
  async getAllComments(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GetAllCommentsDto,
  ) {
    return this.communityService.getAllComments(
      dto.channelId,
      workspaceId,
      {
        paginationToken: dto.paginationToken,
        maxPosts: dto.maxPosts,
      },
    );
  }

  /**
   * Get mentions for a channel
   * POST /community/workspaces/:workspaceId/mentions
   */
  @Post('workspaces/:workspaceId/mentions')
  @HttpCode(HttpStatus.OK)
  async getMentions(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GetMentionsDto,
  ) {
    return this.communityService.getMentions(
      dto.channelId,
      workspaceId,
      {
        paginationToken: dto.paginationToken,
        sinceId: dto.sinceId,
      },
    );
  }

  /**
   * Reply to a comment/mention
   * POST /community/workspaces/:workspaceId/reply
   */
  @Post('workspaces/:workspaceId/reply')
  async createReply(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateReplyDto,
  ) {
    return this.communityService.createReply(
      dto.channelId,
      workspaceId,
      dto.replyToId,
      dto.text,
      dto.mediaUrls,
    );
  }

  /**
   * Get list of platforms that support community features
   * GET /community/platforms
   */
  @Get('platforms')
  getSupportedPlatforms() {
    return {
      platforms: this.communityService.getSupportedPlatforms(),
    };
  }
}
