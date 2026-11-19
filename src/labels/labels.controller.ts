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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  CreateLabelDto,
  MergeLabelDto,
  UpdateLabelDto,
  type Label,
  type LabelList,
} from './dto/label.dto';
import { LabelsService } from './labels.service';

/**
 * The workspace label catalogue (Settings › Labels, spec §5.9). Anyone who
 * may draft posts reads it; MEMBER and up manage it (`labels:manage`).
 * Handler names are pinned by the Settings guard spec (Task 22).
 */
@Controller('labels/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @RequireCapability('posts:draft')
  @Get()
  list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<LabelList> {
    return this.labels.list(workspaceId);
  }

  @RequireCapability('labels:manage')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateLabelDto,
  ): Promise<Label> {
    return this.labels.create(workspaceId, user.userId, dto);
  }

  @RequireCapability('labels:manage')
  @Patch(':labelId')
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() dto: UpdateLabelDto,
  ): Promise<Label> {
    return this.labels.update(workspaceId, labelId, dto);
  }

  /** `intoId` is validated as a UUID by `MergeLabelDto` (`@IsUUID`). */
  @RequireCapability('labels:manage')
  @Post(':labelId/merge')
  @HttpCode(HttpStatus.OK)
  merge(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() dto: MergeLabelDto,
  ): Promise<{ target: Label; moved: number }> {
    return this.labels.merge(workspaceId, labelId, dto.intoId);
  }

  @RequireCapability('labels:manage')
  @Delete(':labelId')
  remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ): Promise<{ undoUntil: string }> {
    return this.labels.remove(workspaceId, labelId);
  }

  @RequireCapability('labels:manage')
  @Post(':labelId/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ): Promise<Label> {
    return this.labels.restore(workspaceId, labelId);
  }
}
