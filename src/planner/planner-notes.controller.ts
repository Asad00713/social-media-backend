import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { CallerRole } from '../posts/guest-rules';
import { CurrentWorkspaceRole } from '../workspace-members/current-workspace-role.decorator';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  CreateNoteDto,
  ListNotesQueryDto,
  UpdateNoteDto,
  type PlannerNoteDto,
} from './dto/planner-notes.dto';
import { PlannerNotesService } from './services/planner-notes.service';

@Controller('planner/workspaces/:workspaceId/notes')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerNotesController {
  constructor(private readonly notes: PlannerNotesService) {}

  @RequireCapability('posts:draft')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListNotesQueryDto,
  ): Promise<PlannerNoteDto[]> {
    return await this.notes.list(workspaceId, query.from, query.to);
  }

  @RequireCapability('posts:publish')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: CreateNoteDto,
  ): Promise<PlannerNoteDto> {
    return await this.notes.create(workspaceId, user.userId, role, dto);
  }

  @RequireCapability('posts:publish')
  @Patch(':id')
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: UpdateNoteDto,
  ): Promise<PlannerNoteDto> {
    return await this.notes.update(workspaceId, id, user.userId, role, dto);
  }

  @RequireCapability('posts:publish')
  @Delete(':id')
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ): Promise<{ message: string }> {
    await this.notes.remove(workspaceId, id, user.userId, role);
    return { message: 'Note deleted' };
  }
}
