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
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentWorkspaceRole } from '../workspace-members/current-workspace-role.decorator';
import type { CallerRole } from './guest-rules';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PostService } from './services/post.service';
import { PlannerPostsService } from './services/planner-posts.service';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { CreatePostDto, UpdatePostDto, PostQueryDto } from './dto/post.dto';

const MAX_CALENDAR_SPAN_DAYS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('posts')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PostsController {
  constructor(
    private readonly postService: PostService,
    private readonly plannerPosts: PlannerPostsService,
  ) {}

  // ==========================================================================
  // Post CRUD Operations
  // ==========================================================================

  /**
   * Create a new post (draft or scheduled)
   */
  @RequireCapability('posts:draft')
  @Post('workspaces/:workspaceId')
  @HttpCode(HttpStatus.CREATED)
  async createPost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: CreatePostDto,
  ) {
    const post = await this.postService.createPost(
      workspaceId,
      user.userId,
      {
        ...dto,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      },
      role,
    );

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
  @RequireCapability('posts:draft')
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
   * Get posts for the calendar view — scheduled, publishing, published, failed
   * and partially published. Drafts are excluded: they carry no date.
   *
   * MUST be declared before the ':postId' routes below — otherwise NestJS
   * matches the literal "calendar" segment as a :postId and the query fails
   * with "invalid input syntax for type uuid: calendar".
   */
  @RequireCapability('posts:draft')
  @Get('workspaces/:workspaceId/calendar')
  async getCalendarPosts(
    @Param('workspaceId') workspaceId: string,
    @Query() query: CalendarQueryDto,
  ) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be valid dates');
    }
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }
    if (to.getTime() - from.getTime() > MAX_CALENDAR_SPAN_DAYS * DAY_MS) {
      throw new BadRequestException(
        `The calendar range is limited to ${MAX_CALENDAR_SPAN_DAYS} days`,
      );
    }
    return await this.plannerPosts.getCalendar(workspaceId, from, to);
  }

  /**
   * Get a single post by ID
   */
  @RequireCapability('posts:draft')
  @Get('workspaces/:workspaceId/:postId')
  async getPost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const post = await this.plannerPosts.getOne(workspaceId, postId);
    return { post };
  }

  /**
   * Update a post
   */
  @RequireCapability('posts:draft')
  @Put('workspaces/:workspaceId/:postId')
  async updatePost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
    @CurrentWorkspaceRole() role: CallerRole,
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
      role,
    );

    return {
      post,
      message: 'Post updated successfully',
    };
  }

  /**
   * Delete a post
   */
  @RequireCapability('posts:draft')
  @Delete('workspaces/:workspaceId/:postId')
  @HttpCode(HttpStatus.OK)
  async deletePost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ) {
    await this.postService.deletePost(postId, workspaceId, user.userId, role);
    return { message: 'Post deleted successfully' };
  }

  // ==========================================================================
  // Publishing Operations
  // ==========================================================================

  /**
   * Publish a post immediately to all target channels
   */
  @RequireCapability('posts:publish')
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
    const failedCount = post.targets.filter(
      (t) => t.status === 'failed',
    ).length;

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
  // History & Analytics
  // ==========================================================================

  /**
   * Get post history (all status changes and publishing attempts)
   */
  @RequireCapability('posts:draft')
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
  @UseGuards(SuperAdminGuard)
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
  @UseGuards(SuperAdminGuard)
  async getRateLimitStatus() {
    const status = await this.postService.getRateLimitStatus();
    return { rateLimits: status };
  }

  /**
   * Get rate limit status for a specific platform
   */
  @Get('rate-limits/:platform')
  @UseGuards(SuperAdminGuard)
  async getPlatformRateLimitStatus(@Param('platform') platform: string) {
    const status = await this.postService.getPlatformRateLimitStatus(
      platform as any,
    );
    return { platform, rateLimit: status };
  }
}
