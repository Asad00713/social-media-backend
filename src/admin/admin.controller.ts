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
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminService, SuspensionReason, SUSPENSION_REASONS } from './admin.service';
import { UserInactivityService } from './user-inactivity.service';

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

@Controller('admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly userInactivityService: UserInactivityService,
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

  @Post('inactivity/run-check')
  @HttpCode(HttpStatus.OK)
  async runInactivityCheck() {
    return this.userInactivityService.runManualCheck();
  }
}
