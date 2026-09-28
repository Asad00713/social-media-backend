import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  UpdateWeeklyPostGoalDto,
  type HomeSummaryDto,
} from './dto/home-summary.dto';
import { HomeService } from './home.service';

@Controller('home/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** Weekly pulse, per-channel growth, streak and goal for the Home overview. */
  @Get('summary')
  @RequireCapability('analytics:view')
  getSummary(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<HomeSummaryDto> {
    return this.home.getSummary(workspaceId);
  }

  @Patch('goal')
  @RequireCapability('posts:publish')
  setGoal(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: UpdateWeeklyPostGoalDto,
  ): Promise<{ weeklyPostGoal: number }> {
    return this.home.setWeeklyPostGoal(workspaceId, body.weeklyPostGoal);
  }
}
