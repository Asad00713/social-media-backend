import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import type { BestTimesDto } from './dto/best-times.dto';
import { BestTimesService } from './services/best-times.service';

@Controller('planner/workspaces/:workspaceId/best-times')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerBestTimesController {
  constructor(private readonly bestTimes: BestTimesService) {}

  @RequireCapability('posts:draft')
  @Get()
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<BestTimesDto> {
    return await this.bestTimes.getForWorkspace(workspaceId, user.userId);
  }
}
