import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import type { SavedReply } from './dto/contract';
import {
  CreateSavedReplyDto,
  ListSavedRepliesQueryDto,
  UpdateSavedReplyDto,
} from './dto/saved-replies.dto';
import { SavedRepliesService } from './services/saved-replies.service';

@Controller('inbox/workspaces/:workspaceId/saved-replies')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SavedRepliesController {
  constructor(private readonly replies: SavedRepliesService) {}

  @RequireCapability('inbox:view')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListSavedRepliesQueryDto,
  ): Promise<SavedReply[]> {
    return await this.replies.list(workspaceId, query.q);
  }

  @RequireCapability('inbox:reply')
  @Post()
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateSavedReplyDto,
  ): Promise<SavedReply> {
    return await this.replies.create(workspaceId, user.userId, dto);
  }

  @RequireCapability('inbox:reply')
  @Patch(':id')
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedReplyDto,
  ): Promise<SavedReply> {
    return await this.replies.update(workspaceId, id, dto);
  }

  @RequireCapability('inbox:reply')
  @Delete(':id')
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.replies.remove(workspaceId, id);
  }

  @RequireCapability('inbox:reply')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SavedReply> {
    return await this.replies.restore(workspaceId, id);
  }

  @RequireCapability('inbox:reply')
  @Post(':id/use')
  @HttpCode(200)
  async use(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ usageCount: number }> {
    return await this.replies.use(workspaceId, id);
  }
}
