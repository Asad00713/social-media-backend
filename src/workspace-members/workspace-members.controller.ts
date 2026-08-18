import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { BatchInviteDto } from './dto/batch-invite.dto';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { RequireCapability } from './require-capability.decorator';

@Controller('workspace-members')
@UseGuards(JwtAuthGuard)
export class WorkspaceMembersController {
  constructor(private readonly membersService: WorkspaceMembersService) {}

  @Post(':workspaceId/invitations')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  inviteMember(
    @Param('workspaceId') workspaceId: string,
    @Body() inviteMemberDto: InviteMemberDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.inviteMember(
      workspaceId,
      inviteMemberDto,
      user.userId,
    );
  }

  // Batch invite (seat-gated up front)
  @Post(':workspaceId/invitations/batch')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  batchInvite(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BatchInviteDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.batchInvite(workspaceId, dto.invites, user.userId);
  }

  // Get pending invitations for a workspace
  @Get(':workspaceId/invitations')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  getPendingInvitations(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.getPendingInvitations(workspaceId, user.userId);
  }

  // Cancel invitation
  @Delete(':workspaceId/invitations/:invitationId')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  cancelInvitation(
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.cancelInvitation(
      workspaceId,
      invitationId,
      user.userId,
    );
  }

  // Get MY pending invitations (invitations sent to me)
  @Get('invitations/me')
  getMyInvitations(@CurrentUser() user: { userId: string; email: string }) {
    return this.membersService.getMyInvitations(user.userId);
  }

  // Accept invitation
  @Post('invitations/accept')
  acceptInvitation(
    @Query('token') token: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.acceptInvitation(token, user.userId);
  }

  // Reject invitation
  @Post('invitations/reject')
  rejectInvitation(
    @Query('token') token: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.rejectInvitation(token, user.userId);
  }

  // ========== MEMBER ENDPOINTS ==========

  // Get all members
  @Get(':workspaceId/members')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:view')
  getMembers(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.getMembers(workspaceId, user.userId);
  }

  // Update member role
  @Patch(':workspaceId/members/:memberId')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  updateMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() updateMemberDto: UpdateMemberDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.updateMemberRole(
      workspaceId,
      memberId,
      updateMemberDto,
      user.userId,
    );
  }

  // Remove member
  // No @RequireCapability here: a member/guest must be able to remove THEIR OWN
  // row (leave the workspace), which a team:manage gate would block. The
  // service's isSelf || owner || admin || super-admin check is the real policy.
  @Delete(':workspaceId/members/:memberId')
  removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.removeMember(workspaceId, memberId, user.userId);
  }
}
