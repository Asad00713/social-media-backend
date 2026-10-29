import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import {
  HideCommentDto,
  LikeCommentDto,
  PrivateReplyDto,
} from './dto/comment-actions.dto';
import { CommentActionsService } from './services/comment-actions.service';

interface AuthUser {
  userId: string;
}

/**
 * All four need `inbox:reply`: a Guest cannot act on comments at all (R6, the
 * greyed "Only members can like as ..." is shown by the capability flags).
 * `DELETE :itemId` has one more segment than `DELETE thread/:threadKey` has
 * before its param, so it never swallows the thread route.
 */
@Controller('inbox/workspaces/:workspaceId/comments')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CommentActionsController {
  constructor(private readonly actions: CommentActionsService) {}

  @Post(':itemId/like')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async like(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: LikeCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return await this.actions.like(workspaceId, itemId, user.userId, dto.liked);
  }

  @Post(':itemId/hide')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async hide(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: HideCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return await this.actions.hide(
      workspaceId,
      itemId,
      user.userId,
      dto.hidden,
    );
  }

  @Delete(':itemId')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return await this.actions.delete(workspaceId, itemId, user.userId);
  }

  @Post(':itemId/private-reply')
  @RequireCapability('inbox:reply')
  @HttpCode(HttpStatus.OK)
  async privateReply(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: PrivateReplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return await this.actions.privateReply(
      workspaceId,
      itemId,
      user.userId,
      dto.text,
    );
  }
}
