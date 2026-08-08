import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  AdminService,
  // Type-only: it now annotates a decorated property, and
  // `emitDecoratorMetadata` would otherwise emit a runtime reference to a type
  // that does not exist at runtime.
  type SuspensionReason,
  SUSPENSION_REASONS,
  WORKSPACE_SORT_FIELDS,
  WORKSPACE_STATES,
  type WorkspaceSortField,
  type WorkspaceState,
} from './admin.service';
import { UserInactivityService } from './user-inactivity.service';
import { QueueMonitorService } from './queue-monitor.service';
import {
  RateLimiterService,
  PLATFORM_RATE_LIMITS,
} from '../queue/rate-limiter.service';
import { SupportedPlatform } from '../drizzle/schema/channels.schema';
import { QUEUES } from '../queue/queue.module';

/**
 * Every DTO in this file carries decorators, and has to.
 *
 * The global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`,
 * which decide what is allowed by looking at the decorators on the class. A
 * plain class has none, so it declares no properties at all: a query DTO ends
 * up with every parameter silently stripped, and a body DTO rejects the whole
 * request with "property reason should not exist". Both failure modes point
 * away from the cause — the first looks like a filter that does not work, the
 * second like a frontend sending the wrong shape.
 */
class SuspendDto {
  @IsIn(SUSPENSION_REASONS)
  reason: SuspensionReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class UserQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;

  @IsOptional()
  @IsString()
  role?: string;
}

class WorkspaceQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  // Capped so a single request cannot ask for the entire table.
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;

  @IsOptional()
  @IsIn(WORKSPACE_STATES)
  state?: WorkspaceState;

  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsIn(WORKSPACE_SORT_FIELDS)
  sortBy?: WorkspaceSortField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

// Queue action DTOs
class RetryJobDto {
  @IsString()
  jobId: string;
}

class CleanQueueDto {
  @IsIn(['completed', 'failed', 'delayed', 'wait'])
  type: 'completed' | 'failed' | 'delayed' | 'wait';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  gracePeriodHours?: number;
}

@Controller('admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly userInactivityService: UserInactivityService,
    private readonly queueMonitorService: QueueMonitorService,
    private readonly rateLimiterService: RateLimiterService,
  ) {}

  // ==========================================================================
  // Dashboard
  // ==========================================================================

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  async getDashboard() {
    return this.adminService.getDashboardOverview();
  }

  @Get('dashboard/activity')
  @HttpCode(HttpStatus.OK)
  async getRecentActivity(@Query('limit') limit?: number) {
    return this.adminService.getRecentActivity(limit);
  }

  @Get('dashboard/health')
  @HttpCode(HttpStatus.OK)
  async getSystemHealth() {
    return this.adminService.getSystemHealth();
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  @Get('users')
  @HttpCode(HttpStatus.OK)
  async getUsers(@Query() query: UserQueryDto) {
    return this.adminService.getUsers({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      search: query.search,
      isActive:
        query.isActive !== undefined
          ? query.isActive === true || query.isActive === ('true' as any)
          : undefined,
      role: query.role,
    });
  }

  @Get('users/:userId')
  @HttpCode(HttpStatus.OK)
  async getUserById(@Param('userId') userId: string) {
    return this.adminService.getUserById(userId);
  }

  @Post('users/:userId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendUser(
    @Param('userId') userId: string,
    @CurrentUser() admin: { userId: string },
    @Body() dto: SuspendDto,
  ) {
    // The reason is checked by `@IsIn(SUSPENSION_REASONS)` on the DTO, which
    // runs before this method and returns a 400 naming the valid values. The
    // hand-rolled check that used to sit here ran after validation had already
    // passed, so it could never fire.
    return this.adminService.suspendUser(
      userId,
      admin.userId,
      dto.reason,
      dto.note,
    );
  }

  @Post('users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivateUser(@Param('userId') userId: string) {
    return this.adminService.reactivateUser(userId);
  }

  // ==========================================================================
  // Workspace Management
  // ==========================================================================

  @Get('workspaces')
  @HttpCode(HttpStatus.OK)
  async getWorkspaces(@Query() query: WorkspaceQueryDto) {
    // The DTO's decorators already coerced and validated everything, so the
    // hand-rolled Number() and 'true'-string juggling that used to live here
    // is gone — it was doing the pipe's job, and doing it in two places is how
    // the two drift apart.
    return this.adminService.getWorkspaces({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      search: query.search,
      isActive: query.isActive,
      state: query.state,
      planCode: query.planCode,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('workspaces/:workspaceId')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceById(@Param('workspaceId') workspaceId: string) {
    return this.adminService.getWorkspaceById(workspaceId);
  }

  @Get('workspaces/:workspaceId/billing')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceBilling(@Param('workspaceId') workspaceId: string) {
    return this.adminService.getWorkspaceBilling(workspaceId);
  }

  @Post('workspaces/:workspaceId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() admin: { userId: string },
    @Body() dto: SuspendDto,
  ) {
    // Reason validated by the DTO — see the note on `suspendUser`.
    return this.adminService.suspendWorkspace(
      workspaceId,
      admin.userId,
      dto.reason,
      dto.note,
    );
  }

  @Post('workspaces/:workspaceId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivateWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.adminService.reactivateWorkspace(workspaceId);
  }

  // ==========================================================================
  // Analytics
  // ==========================================================================

  @Get('analytics/channels')
  @HttpCode(HttpStatus.OK)
  async getChannelStats() {
    return this.adminService.getChannelStats();
  }

  @Get('analytics/posts')
  @HttpCode(HttpStatus.OK)
  async getPostStats() {
    return this.adminService.getPostStats();
  }

  @Get('analytics/revenue')
  @HttpCode(HttpStatus.OK)
  async getRevenueStats() {
    return this.adminService.getRevenueStats();
  }

  // ==========================================================================
  // User Inactivity
  // ==========================================================================

  @Get('inactivity/stats')
  @HttpCode(HttpStatus.OK)
  async getInactivityStats() {
    return this.userInactivityService.getInactivityStats();
  }

  @Get('inactivity/email-stats')
  @HttpCode(HttpStatus.OK)
  async getInactivityEmailStats() {
    return this.userInactivityService.getInactivityEmailStats();
  }

  @Post('inactivity/run-check')
  @HttpCode(HttpStatus.OK)
  async runInactivityCheck() {
    return this.userInactivityService.runManualCheck();
  }

  // ==========================================================================
  // AI Usage
  // ==========================================================================

  @Get('ai-usage/stats')
  @HttpCode(HttpStatus.OK)
  async getAiUsageStats() {
    return this.adminService.getAiUsageStats();
  }

  @Get('ai-usage/activity')
  @HttpCode(HttpStatus.OK)
  async getAiUsageActivity(@Query('limit') limit?: number) {
    return this.adminService.getAiUsageActivity(limit ? Number(limit) : 50);
  }

  // ==========================================================================
  // Queue Monitoring
  // ==========================================================================

  /**
   * Get all queues overview
   */
  @Get('queues')
  @HttpCode(HttpStatus.OK)
  async getQueuesOverview() {
    const [stats, aggregate] = await Promise.all([
      this.queueMonitorService.getAllQueueStats(),
      this.queueMonitorService.getAggregateStats(),
    ]);

    return {
      queues: stats,
      aggregate,
      availableQueues: Object.values(QUEUES),
    };
  }

  /**
   * Get stats for a specific queue
   */
  @Get('queues/:queueName')
  @HttpCode(HttpStatus.OK)
  async getQueueStats(@Param('queueName') queueName: string) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(
        `Invalid queue name. Available: ${Object.values(QUEUES).join(', ')}`,
      );
    }

    const stats = await this.queueMonitorService.getQueueStats(queueName);
    return stats;
  }

  /**
   * Get failed jobs for a queue
   */
  @Get('queues/:queueName/failed')
  @HttpCode(HttpStatus.OK)
  async getFailedJobs(
    @Param('queueName') queueName: string,
    @Query('limit') limit?: number,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const jobs = await this.queueMonitorService.getFailedJobs(
      queueName,
      limit ? Number(limit) : 20,
    );
    return { queueName, jobs, count: jobs.length };
  }

  /**
   * Get active jobs for a queue
   */
  @Get('queues/:queueName/active')
  @HttpCode(HttpStatus.OK)
  async getActiveJobs(
    @Param('queueName') queueName: string,
    @Query('limit') limit?: number,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const jobs = await this.queueMonitorService.getActiveJobs(
      queueName,
      limit ? Number(limit) : 20,
    );
    return { queueName, jobs, count: jobs.length };
  }

  /**
   * Get waiting jobs for a queue
   */
  @Get('queues/:queueName/waiting')
  @HttpCode(HttpStatus.OK)
  async getWaitingJobs(
    @Param('queueName') queueName: string,
    @Query('limit') limit?: number,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const jobs = await this.queueMonitorService.getWaitingJobs(
      queueName,
      limit ? Number(limit) : 20,
    );
    return { queueName, jobs, count: jobs.length };
  }

  /**
   * Get delayed jobs for a queue
   */
  @Get('queues/:queueName/delayed')
  @HttpCode(HttpStatus.OK)
  async getDelayedJobs(
    @Param('queueName') queueName: string,
    @Query('limit') limit?: number,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const jobs = await this.queueMonitorService.getDelayedJobs(
      queueName,
      limit ? Number(limit) : 20,
    );
    return { queueName, jobs, count: jobs.length };
  }

  /**
   * Get completed jobs for a queue
   */
  @Get('queues/:queueName/completed')
  @HttpCode(HttpStatus.OK)
  async getCompletedJobs(
    @Param('queueName') queueName: string,
    @Query('limit') limit?: number,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const jobs = await this.queueMonitorService.getCompletedJobs(
      queueName,
      limit ? Number(limit) : 20,
    );
    return { queueName, jobs, count: jobs.length };
  }

  /**
   * Retry a specific failed job
   */
  @Post('queues/:queueName/retry')
  @HttpCode(HttpStatus.OK)
  async retryFailedJob(
    @Param('queueName') queueName: string,
    @Body() dto: RetryJobDto,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    return this.queueMonitorService.retryFailedJob(queueName, dto.jobId);
  }

  /**
   * Retry all failed jobs in a queue
   */
  @Post('queues/:queueName/retry-all')
  @HttpCode(HttpStatus.OK)
  async retryAllFailedJobs(@Param('queueName') queueName: string) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    return this.queueMonitorService.retryAllFailedJobs(queueName);
  }

  /**
   * Remove a specific job
   */
  @Post('queues/:queueName/remove')
  @HttpCode(HttpStatus.OK)
  async removeJob(
    @Param('queueName') queueName: string,
    @Body() dto: RetryJobDto,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    return this.queueMonitorService.removeFailedJob(queueName, dto.jobId);
  }

  /**
   * Clean old jobs from a queue
   */
  @Post('queues/:queueName/clean')
  @HttpCode(HttpStatus.OK)
  async cleanQueue(
    @Param('queueName') queueName: string,
    @Body() dto: CleanQueueDto,
  ) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    const gracePeriodMs = (dto.gracePeriodHours || 24) * 60 * 60 * 1000;
    return this.queueMonitorService.cleanQueue(
      queueName,
      dto.type,
      gracePeriodMs,
    );
  }

  /**
   * Pause a queue
   */
  @Post('queues/:queueName/pause')
  @HttpCode(HttpStatus.OK)
  async pauseQueue(@Param('queueName') queueName: string) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    return this.queueMonitorService.pauseQueue(queueName);
  }

  /**
   * Resume a queue
   */
  @Post('queues/:queueName/resume')
  @HttpCode(HttpStatus.OK)
  async resumeQueue(@Param('queueName') queueName: string) {
    if (!Object.values(QUEUES).includes(queueName as any)) {
      throw new BadRequestException(`Invalid queue name`);
    }

    return this.queueMonitorService.resumeQueue(queueName);
  }

  // ==========================================================================
  // Rate Limiting
  // ==========================================================================

  /**
   * Get rate limit status for all platforms
   */
  @Get('rate-limits')
  @HttpCode(HttpStatus.OK)
  async getAllRateLimits() {
    const status = await this.rateLimiterService.getAllRateLimitStatus();

    return {
      platforms: status,
      limits: PLATFORM_RATE_LIMITS,
    };
  }

  /**
   * Get rate limit status for a specific platform
   */
  @Get('rate-limits/:platform')
  @HttpCode(HttpStatus.OK)
  async getPlatformRateLimit(@Param('platform') platform: string) {
    if (!PLATFORM_RATE_LIMITS[platform as SupportedPlatform]) {
      throw new BadRequestException(
        `Invalid platform. Available: ${Object.keys(PLATFORM_RATE_LIMITS).join(', ')}`,
      );
    }

    const status = await this.rateLimiterService.getPlatformRateLimitStatus(
      platform as SupportedPlatform,
    );

    return {
      platform,
      ...status,
      limit: PLATFORM_RATE_LIMITS[platform as SupportedPlatform],
    };
  }
}
