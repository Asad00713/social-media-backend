import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  DEFAULT_LIST_LIMIT,
  PlannerListQueryDto,
  type PlannerListDto,
} from './dto/planner-list.dto';
import { PlannerListService } from './services/planner-list.service';

@Controller('planner/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerController {
  constructor(private readonly listService: PlannerListService) {}

  @RequireCapability('posts:draft')
  @Get('list')
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: PlannerListQueryDto,
  ): Promise<PlannerListDto> {
    return await this.listService.list(workspaceId, {
      tab: query.tab,
      limit: query.limit ?? DEFAULT_LIST_LIMIT,
      cursor: query.cursor,
    });
  }
}
