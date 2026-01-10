import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';

@Controller('workspace-members')
@UseGuards(JwtAuthGuard)
export class WorkspaceMembersController {
    constructor(private readonly membersService: WorkspaceMembersService) { }

    @Post(':workspaceId/invitations')
    inviteMember(
        @Param('workspaceId') workspaceId: string,
        @Body() inviteMemberDto: InviteMemberDto,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        return this.membersService.inviteMember(workspaceId, inviteMemberDto, user.userId);
    }

    // Get pending invitations for a workspace
    @Get(':workspaceId/invitations')
    getPendingInvitations(
        @Param('workspaceId') workspaceId: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        return this.membersService.getPendingInvitations(workspaceId, user.userId);
    }

    // Cancel invitation
    @Delete(':workspaceId/invitations/:invitationId')
    cancelInvitation(
        @Param('workspaceId') workspaceId: string,
        @Param('invitationId') invitationId: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        return this.membersService.cancelInvitation(workspaceId, invitationId, user.userId);
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
    getMembers(
        @Param('workspaceId') workspaceId: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        return this.membersService.getMembers(workspaceId, user.userId);
    }

    // Update member role
    @Patch(':workspaceId/members/:memberId')
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
    @Delete(':workspaceId/members/:memberId')
    removeMember(
        @Param('workspaceId') workspaceId: string,
        @Param('memberId') memberId: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        return this.membersService.removeMember(workspaceId, memberId, user.userId);
    }
}
