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
  LastPostTimeQueryDto,
  MonthCountsQueryDto,
  NextPostQueryDto,
  PlannerListQueryDto,
  type LastPostTimeDto,
  type MonthCountsDto,
  type NextPostDto,
  type PlannerListDto,
} from './dto/planner-list.dto';
import { PlannerLookupService } from './services/planner-lookup.service';
import { PlannerListService } from './services/planner-list.service';

@Controller('planner/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerController {
  constructor(
    private readonly listService: PlannerListService,
    private readonly lookupService: PlannerLookupService,
  ) {}

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

  @RequireCapability('posts:draft')
  @Get('month-counts')
  async monthCounts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: MonthCountsQueryDto,
  ): Promise<MonthCountsDto> {
    return await this.lookupService.monthCounts(workspaceId, query.year);
  }

  @RequireCapability('posts:draft')
  @Get('next-post')
  async nextPost(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: NextPostQueryDto,
  ): Promise<NextPostDto> {
    return await this.lookupService.nextPost(
      workspaceId,
      new Date(query.after),
    );
  }

  @RequireCapability('posts:draft')
  @Get('last-post-time')
  async lastPostTime(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: LastPostTimeQueryDto,
  ): Promise<LastPostTimeDto> {
    return await this.lookupService.lastPostTime(
      workspaceId,
      query.channelIds.split(',').map(Number),
    );
  }
}
