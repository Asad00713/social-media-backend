import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { SkipSuspendCheck } from '../auth/decorators/skip-suspend-check.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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
  SUBSCRIPTION_STATUSES,
  INVOICE_STATUSES,
  USER_STATES,
  WORKSPACE_CHANNEL_HEALTH_FILTERS,
  WORKSPACE_LIMIT_FILTERS,
  WORKSPACE_SORT_FIELDS,
  WORKSPACE_STATES,
  type UserState,
  type WorkspaceChannelHealthFilter,
  type WorkspaceLimitFilter,
  type WorkspaceSortField,
  type WorkspaceState,
} from './admin.service';
import {
  CONNECTION_STATUSES,
  POST_STATUSES,
  type PostStatus,
} from '../drizzle/schema';
import { ChannelService } from '../channels/services/channel.service';
import { WorkspaceMembersService } from '../workspace-members/workspace-members.service';
import { UpdateMemberDto } from '../workspace-members/dto/update-member.dto';
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
  @IsIn(USER_STATES)
  state?: UserState;

  @IsOptional()
  @IsString()
  role?: string;
}

class ChannelQueryDto {
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

  // Free string, not a whitelist: an unknown platform simply matches nothing,
  // and the list of platforms grows without this DTO having to be kept in step.
  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsIn(CONNECTION_STATUSES)
  status?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  needsAttention?: boolean;
}

class SubscriptionQueryDto {
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
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: string;

  // Free string, not a whitelist: plan codes are seeded data that can grow, and
  // an unknown code simply matches nothing.
  @IsOptional()
  @IsString()
  planCode?: string;
}

class InvoiceQueryDto {
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
  @IsIn(INVOICE_STATUSES)
  status?: string;
}

class OverviewQueryDto {
  // Sizes the time series and the deltas; the headline totals ignore it.
  @IsOptional()
  @IsIn(['7d', '30d', '90d'])
  period?: '7d' | '30d' | '90d';
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
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  hasRevenue?: boolean;

  @IsOptional()
  @IsIn(WORKSPACE_LIMIT_FILTERS)
  atLimit?: WorkspaceLimitFilter;

  @IsOptional()
  @IsIn(WORKSPACE_CHANNEL_HEALTH_FILTERS)
  channelHealth?: WorkspaceChannelHealthFilter;

  // Dates arrive as ISO strings on a query string. `@Type(() => Date)` does
  // the conversion, and `@IsDate` rejects anything that did not parse — an
  // Invalid Date reaching the query would produce an empty result set with
  // nothing to explain it.
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdAfter?: Date;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdBefore?: Date;

  @IsOptional()
  @IsIn(WORKSPACE_SORT_FIELDS)
  sortBy?: WorkspaceSortField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

class BulkIdsDto {
  @IsArray()
  // Capped so one request cannot suspend the entire platform by accident.
  // Fifty is more than a page of the table, which is where the selection
  // comes from.
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  workspaceIds: string[];
}

class BulkSuspendDto extends BulkIdsDto {
  @IsIn(SUSPENSION_REASONS)
  reason: SuspensionReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class WorkspacePostsQueryDto {
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
  @IsIn(POST_STATUSES)
  status?: PostStatus;
}

class WorkspaceMediaQueryDto {
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
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeDeleted?: boolean;
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
// Admin routes are never subject to the billing-suspension lock. A super admin
// has to reach a suspended workspace precisely to inspect it and switch it back
// on; the global WorkspaceSuspendedGuard, which keys off the `:workspaceId`
// param alone, would otherwise 403 every admin call into a suspended workspace
// and make it un-openable and un-reactivatable from here.
@SkipSuspendCheck()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly userInactivityService: UserInactivityService,
    private readonly queueMonitorService: QueueMonitorService,
    private readonly rateLimiterService: RateLimiterService,
    // The customer-facing services, used directly rather than wrapped: the
    // side effects an admin needs are already inside them.
    private readonly channelService: ChannelService,
    private readonly membersService: WorkspaceMembersService,
  ) {}

  // ==========================================================================
  // Dashboard
  // ==========================================================================

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  async getDashboard() {
    return this.adminService.getDashboardOverview();
  }

  // The landing page's single call: headline totals, MRR, plan mix, growth and
  // publishing series, top AI spenders and recent activity in one response.
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  async getOverview(@Query() query: OverviewQueryDto) {
    return this.adminService.getAdminOverview(query.period);
  }

  @Get('dashboard/activity')
  @HttpCode(HttpStatus.OK)
  async getRecentActivity(@Query('limit') limit?: number) {
    return this.adminService.getRecentActivity(limit);
  }

  @Get('dashboard/health')
  @HttpCode(HttpStatus.OK)
  async getSystemHealth() {
    // The queue service owns the Redis connection, so it runs that ping; the
    // admin service runs the DB ping and folds both into one reading.
    const redis = await this.queueMonitorService.pingRedis();
    return this.adminService.getSystemHealth(redis);
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
      state: query.state,
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
      hasRevenue: query.hasRevenue,
      atLimit: query.atLimit,
      channelHealth: query.channelHealth,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('workspaces/:workspaceId')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceById(@Param('workspaceId') workspaceId: string) {
    return this.adminService.getWorkspaceById(workspaceId);
  }

  @Get('workspaces/:workspaceId/posts')
  @HttpCode(HttpStatus.OK)
  async getWorkspacePosts(
    @Param('workspaceId') workspaceId: string,
    @Query() query: WorkspacePostsQueryDto,
  ) {
    return this.adminService.getWorkspacePosts(workspaceId, {
      page: query.page,
      limit: query.limit,
      status: query.status,
    });
  }

  @Get('workspaces/:workspaceId/media')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceMedia(
    @Param('workspaceId') workspaceId: string,
    @Query() query: WorkspaceMediaQueryDto,
  ) {
    return this.adminService.getWorkspaceMedia(workspaceId, {
      page: query.page,
      limit: query.limit,
      includeDeleted: query.includeDeleted,
    });
  }

  @Get('workspaces/:workspaceId/billing')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceBilling(@Param('workspaceId') workspaceId: string) {
    return this.adminService.getWorkspaceBilling(workspaceId);
  }

  // The bulk routes sit above `workspaces/:workspaceId/...` deliberately.
  // Express matches in declaration order, so with the parameterised route
  // first, `/workspaces/bulk/suspend` binds `workspaceId = 'bulk'` and the
  // bulk handler is never reached — a 404 on a workspace called "bulk"
  // rather than anything that points at the routing.
  @Post('workspaces/bulk/suspend')
  @HttpCode(HttpStatus.OK)
  async bulkSuspendWorkspaces(
    @CurrentUser() admin: { userId: string },
    @Body() dto: BulkSuspendDto,
  ) {
    return this.adminService.bulkSuspendWorkspaces(
      dto.workspaceIds,
      admin.userId,
      dto.reason,
      dto.note,
    );
  }

  @Post('workspaces/bulk/reactivate')
  @HttpCode(HttpStatus.OK)
  async bulkReactivateWorkspaces(@Body() dto: BulkIdsDto) {
    return this.adminService.bulkReactivateWorkspaces(dto.workspaceIds);
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

  @Delete('workspaces/:workspaceId/channels/:channelId')
  @HttpCode(HttpStatus.OK)
  async disconnectWorkspaceChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId', ParseIntPipe) channelId: number,
  ) {
    // The customer-facing service, not a local delete. It cancels the
    // channel's sync jobs, revokes the Google grant while the token still
    // exists, and moves the billable channel counter back down — none of
    // which a row delete here would do.
    await this.channelService.deleteChannel(channelId, workspaceId);
    return { success: true, message: 'Channel disconnected' };
  }

  @Patch('workspaces/:workspaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  async updateWorkspaceMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() admin: { userId: string },
    // The members module's own DTO, so the roles the admin dashboard can set
    // are exactly the roles the customer-facing endpoint accepts.
    @Body() dto: UpdateMemberDto,
  ) {
    return this.membersService.updateMemberRole(
      workspaceId,
      memberId,
      dto,
      admin.userId,
    );
  }

  @Delete('workspaces/:workspaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  async removeWorkspaceMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() admin: { userId: string },
  ) {
    return this.membersService.removeMember(
      workspaceId,
      memberId,
      admin.userId,
    );
  }

  /**
   * Separate from removing a member because the underlying rows are in
   * different states. `removeMember` only matches ACCEPTED invitations and
   * decrements the member counter; a PENDING invitation was never counted, so
   * cancelling it is a different operation on the same table.
   */
  @Delete('workspaces/:workspaceId/invitations/:invitationId')
  @HttpCode(HttpStatus.OK)
  async cancelWorkspaceInvitation(
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
    @CurrentUser() admin: { userId: string },
  ) {
    return this.membersService.cancelInvitation(
      workspaceId,
      invitationId,
      admin.userId,
    );
  }

  @Post('workspaces/:workspaceId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivateWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.adminService.reactivateWorkspace(workspaceId);
  }

  // ==========================================================================
  // Channel Management
  // ==========================================================================

  @Get('channels')
  @HttpCode(HttpStatus.OK)
  async getChannels(@Query() query: ChannelQueryDto) {
    return this.adminService.getAdminChannels({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      search: query.search,
      platform: query.platform,
      status: query.status,
      needsAttention: query.needsAttention,
    });
  }

  // ==========================================================================
  // Billing Management
  // ==========================================================================

  @Get('subscriptions')
  @HttpCode(HttpStatus.OK)
  async getSubscriptions(@Query() query: SubscriptionQueryDto) {
    return this.adminService.getAdminSubscriptions({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      search: query.search,
      status: query.status,
      planCode: query.planCode,
    });
  }

  @Get('invoices')
  @HttpCode(HttpStatus.OK)
  async getInvoices(@Query() query: InvoiceQueryDto) {
    return this.adminService.getAdminInvoices({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      search: query.search,
      status: query.status,
    });
  }

  @Get('billing/addons')
  @HttpCode(HttpStatus.OK)
  async getAddons() {
    return this.adminService.getAdminAddons();
  }

  // The revenue screen's live figures: MRR split by subscription health, plan
  // mix and catalogue, invoice summary, and the payment-failure picture.
  @Get('revenue')
  @HttpCode(HttpStatus.OK)
  async getRevenue() {
    return this.adminService.getAdminRevenue();
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
  // Storage Usage
  // ==========================================================================

  @Get('storage/usage')
  @HttpCode(HttpStatus.OK)
  async getStorageUsage() {
    return this.adminService.getStorageUsage();
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
