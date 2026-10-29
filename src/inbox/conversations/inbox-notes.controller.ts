import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import type { TimelineEntry } from './dto/contract';
import { CreateNoteDto } from './dto/inbox-notes.dto';
import { InboxNotesService } from './services/inbox-notes.service';

// No GET: notes reach the client inside the conversation detail timeline.
@Controller('inbox/workspaces/:workspaceId/conversations/:conversationId/notes')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class InboxNotesController {
  constructor(private readonly notes: InboxNotesService) {}

  @RequireCapability('inbox:reply')
  @Post()
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateNoteDto,
  ): Promise<TimelineEntry> {
    return await this.notes.create(
      workspaceId,
      conversationId,
      user.userId,
      dto,
    );
  }

  @RequireCapability('inbox:reply')
  @Delete(':noteId')
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<{ ok: true }> {
    return await this.notes.remove(
      workspaceId,
      conversationId,
      noteId,
      user.userId,
    );
  }
}
