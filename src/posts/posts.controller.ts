import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PostService } from './services/post.service';
import { CreatePostDto, UpdatePostDto, PostQueryDto } from './dto/post.dto';

@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly postService: PostService) {}

  // ==========================================================================
  // Post CRUD Operations
  // ==========================================================================

  /**
   * Create a new post (draft or scheduled)
   */
  @Post('workspaces/:workspaceId')
  @HttpCode(HttpStatus.CREATED)
  async createPost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreatePostDto,
  ) {
    const post = await this.postService.createPost(workspaceId, user.userId, {
      ...dto,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
    });

    return {
      post,
      message: dto.scheduledAt
        ? 'Post scheduled successfully'
        : 'Post draft created successfully',
    };
  }

  /**
   * Get all posts for a workspace
   */
  @Get('workspaces/:workspaceId')
  async getWorkspacePosts(
    @Param('workspaceId') workspaceId: string,
    @Query() query: PostQueryDto,
  ) {
    const result = await this.postService.getWorkspacePosts(workspaceId, {
      status: query.status,
      channelId: query.channelId,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      posts: result.posts,
      total: result.total,
      limit: query.limit || 50,
      offset: query.offset || 0,
    };
  }

  /**
   * Get a single post by ID
   */
  @Get('workspaces/:workspaceId/:postId')
  async getPost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const post = await this.postService.getPost(postId, workspaceId);
    return { post };
  }

  /**
   * Update a post
   */
  @Put('workspaces/:workspaceId/:postId')
  async updatePost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: UpdatePostDto,
  ) {
    const post = await this.postService.updatePost(
      postId,
      workspaceId,
      user.userId,
      {
        ...dto,
        scheduledAt:
          dto.scheduledAt === null
            ? null
            : dto.scheduledAt
              ? new Date(dto.scheduledAt)
              : undefined,
      },
    );

    return {
      post,
      message: 'Post updated successfully',
    };
  }

  /**
   * Delete a post
   */
  @Delete('workspaces/:workspaceId/:postId')
  @HttpCode(HttpStatus.OK)
  async deletePost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    await this.postService.deletePost(postId, workspaceId, user.userId);
    return { message: 'Post deleted successfully' };
  }

  // ==========================================================================
  // Publishing Operations
  // ==========================================================================

  /**
   * Publish a post immediately to all target channels
   */
  @Post('workspaces/:workspaceId/:postId/publish')
  @HttpCode(HttpStatus.OK)
  async publishPost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const post = await this.postService.publishPost(
      postId,
      workspaceId,
      user.userId,
    );

    const successCount = post.targets.filter(
      (t) => t.status === 'published',
    ).length;
    const failedCount = post.targets.filter((t) => t.status === 'failed').length;

    return {
      post,
      message:
        post.status === 'published'
          ? 'Post published successfully to all channels'
          : post.status === 'partially_published'
            ? `Post published to ${successCount} channel(s), ${failedCount} failed`
            : 'Post publishing failed',
      summary: {
        total: post.targets.length,
        published: successCount,
        failed: failedCount,
      },
    };
  }

  // ==========================================================================
  // Calendar & Scheduling
  // ==========================================================================

  /**
   * Get scheduled posts for calendar view
   */
  @Get('workspaces/:workspaceId/calendar')
  async getCalendarPosts(
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!from || !to) {
      throw new Error('from and to date parameters are required');
    }

    const scheduledPosts = await this.postService.getScheduledPosts(
      workspaceId,
      new Date(from),
      new Date(to),
    );

    // Group by date for calendar display
    const byDate: Record<string, typeof scheduledPosts> = {};

    for (const post of scheduledPosts) {
      if (post.scheduledAt) {
        const dateKey = post.scheduledAt.toISOString().split('T')[0];
        if (!byDate[dateKey]) {
          byDate[dateKey] = [];
        }
        byDate[dateKey].push(post);
      }
    }

    return {
      posts: scheduledPosts,
      byDate,
      total: scheduledPosts.length,
    };
  }

  // ==========================================================================
  // History & Analytics
  // ==========================================================================

  /**
   * Get post history (all status changes and publishing attempts)
   */
  @Get('workspaces/:workspaceId/:postId/history')
  async getPostHistory(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const history = await this.postService.getPostHistory(postId, workspaceId);
    return { history };
  }

  // ==========================================================================
  // Queue Status (Admin/Debugging)
  // ==========================================================================

  /**
   * Get queue status for monitoring
   */
  @Get('queue/status')
  async getQueueStatus() {
    const status = await this.postService.getQueueStatus();
    return { queue: status };
  }

  // ==========================================================================
  // Rate Limiting Status
  // ==========================================================================

  /**
   * Get rate limit status for all platforms
   */
  @Get('rate-limits')
  async getRateLimitStatus() {
    const status = await this.postService.getRateLimitStatus();
    return { rateLimits: status };
  }

  /**
   * Get rate limit status for a specific platform
   */
  @Get('rate-limits/:platform')
  async getPlatformRateLimitStatus(@Param('platform') platform: string) {
    const status = await this.postService.getPlatformRateLimitStatus(
      platform as any,
    );
    return { platform, rateLimit: status };
  }
}
