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
import { AdminService, SuspensionReason, SUSPENSION_REASONS } from './admin.service';
import { UserInactivityService } from './user-inactivity.service';
import { QueueMonitorService } from './queue-monitor.service';
import { RateLimiterService, PLATFORM_RATE_LIMITS } from '../queue/rate-limiter.service';
import { SupportedPlatform } from '../drizzle/schema/channels.schema';
import { QUEUES } from '../queue/queue.module';

// DTOs
class SuspendDto {
  reason: SuspensionReason;
  note?: string;
}

class UserQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
  role?: string;
}

class WorkspaceQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

// Queue action DTOs
class RetryJobDto {
  jobId: string;
}

class CleanQueueDto {
  type: 'completed' | 'failed' | 'delayed' | 'wait';
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
      isActive: query.isActive !== undefined ? query.isActive === true || query.isActive === ('true' as any) : undefined,
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
    if (!SUSPENSION_REASONS.includes(dto.reason)) {
      return {
        error: 'Invalid suspension reason',
        validReasons: SUSPENSION_REASONS,
      };
    }
    return this.adminService.suspendUser(userId, admin.userId, dto.reason, dto.note);
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
    return this.adminService.getWorkspaces({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      search: query.search,
      isActive: query.isActive !== undefined ? query.isActive === true || query.isActive === ('true' as any) : undefined,
    });
  }

  @Get('workspaces/:workspaceId')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceById(@Param('workspaceId') workspaceId: string) {
    return this.adminService.getWorkspaceById(workspaceId);
  }

  @Post('workspaces/:workspaceId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() admin: { userId: string },
    @Body() dto: SuspendDto,
  ) {
    if (!SUSPENSION_REASONS.includes(dto.reason)) {
      return {
        error: 'Invalid suspension reason',
        validReasons: SUSPENSION_REASONS,
      };
    }
    return this.adminService.suspendWorkspace(workspaceId, admin.userId, dto.reason, dto.note);
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
    return this.queueMonitorService.cleanQueue(queueName, dto.type, gracePeriodMs);
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
