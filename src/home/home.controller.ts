import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  UpdateWeeklyPostGoalDto,
  type HomePulseDto,
  type HomeSummaryDto,
} from './dto/home-summary.dto';
import { HomeService } from './home.service';
import { PULSE_RANGES, isPulseRange } from './lib/home-summary';

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

  /** Performance over the last 7, 30 or 90 days, with a point per day. */
  @Get('pulse')
  @RequireCapability('analytics:view')
  getPulse(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
  ): Promise<HomePulseDto> {
    if (!isPulseRange(days)) {
      throw new BadRequestException(
        `days must be one of ${PULSE_RANGES.join(', ')}`,
      );
    }
    return this.home.getPulse(workspaceId, days);
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
