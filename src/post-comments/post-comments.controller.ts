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
import type { CallerRole } from '../workspace-members/caller-role';
import { CurrentWorkspaceRole } from '../workspace-members/current-workspace-role.decorator';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  CreatePostCommentDto,
  UpdatePostCommentDto,
  type PostCommentDto,
} from './dto/post-comments.dto';
import { PostCommentsService } from './post-comments.service';

/**
 * Team comments on a post — the composer's "Comments" row. Anyone who may
 * see the post (`posts:view`, Guest included) reads the thread. Commenting
 * (`posts:comment`, also Guest) covers posting a comment, resolving or
 * reopening one, and deleting your own: resolving is part of commenting.
 * Deleting someone else's comment is for admins (checked in the service).
 */
@Controller('posts/workspaces/:workspaceId/:postId/comments')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PostCommentsController {
  constructor(private readonly comments: PostCommentsService) {}

  @RequireCapability('posts:view')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ): Promise<PostCommentDto[]> {
    return this.comments.list(workspaceId, postId, user.userId, role);
  }

  @RequireCapability('posts:comment')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: CreatePostCommentDto,
  ): Promise<PostCommentDto> {
    return this.comments.create(
      workspaceId,
      postId,
      user.userId,
      role,
      dto.body,
    );
  }

  @RequireCapability('posts:comment')
  @Patch(':commentId')
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: UpdatePostCommentDto,
  ): Promise<PostCommentDto> {
    return this.comments.setResolved(
      workspaceId,
      postId,
      commentId,
      user.userId,
      role,
      dto.resolved,
    );
  }

  @RequireCapability('posts:comment')
  @Delete(':commentId')
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
  ): Promise<{ message: string }> {
    await this.comments.remove(
      workspaceId,
      postId,
      commentId,
      user.userId,
      role,
    );
    return { message: 'Comment deleted' };
  }
}
