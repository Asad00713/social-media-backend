import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { PostIdsDto } from './dto/post-ids.dto';
import { SaveBrandDto } from './dto/save-brand.dto';
import { FirstWeekService, type ScheduleResult } from './first-week.service';
import type { FirstWeekProfileView, FirstWeekState } from './first-week.types';

/** Home "first week". JWT first (sets req.user), then the workspace capability map. */
@Controller('workspaces/:workspaceId/first-week')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class FirstWeekController {
  constructor(private readonly firstWeek: FirstWeekService) {}

  @Get()
  @RequireCapability('analytics:view')
  getState(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<FirstWeekState> {
    return this.firstWeek.getState(workspaceId);
  }

  @Put('brand')
  @RequireCapability('posts:publish')
  saveBrand(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: SaveBrandDto,
  ): Promise<FirstWeekProfileView> {
    return this.firstWeek.saveBrand(workspaceId, user.userId, dto);
  }

  @Post('retry')
  @HttpCode(200)
  @RequireCapability('posts:publish')
  retry(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<FirstWeekProfileView> {
    return this.firstWeek.retry(workspaceId, user.userId);
  }

  @Post('schedule')
  @HttpCode(200)
  @RequireCapability('posts:publish')
  schedule(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: PostIdsDto,
  ): Promise<ScheduleResult> {
    return this.firstWeek.schedule(workspaceId, user.userId, dto.postIds);
  }

  @Post('unschedule')
  @HttpCode(200)
  @RequireCapability('posts:publish')
  unschedule(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: PostIdsDto,
  ): Promise<{ unscheduled: string[] }> {
    return this.firstWeek.unschedule(workspaceId, dto.postIds);
  }
}
