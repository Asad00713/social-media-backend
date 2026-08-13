// src/workspace-members/workspace-members.service.ts
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { and, eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { users, workspace, workspaceInvitation } from 'src/drizzle/schema';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MemberRole } from './dto/add-member.dto';
import { UsageService } from 'src/billing/services/usage.service';
import { EmailService } from 'src/email/email.service';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class WorkspaceMembersService {
  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private emailService: EmailService,
    private usersService: UsersService,
  ) {}

  // ==================== INVITATION FLOW ====================

  // Step 1: Send invitation
  async inviteMember(
    workspaceId: string,
    inviteMemberDto: InviteMemberDto,
    currentUserId: string,
  ) {
    // 1. Check workspace exists and user has permission
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only workspace owner or admins can invite members',
      );
    }

    // 1.5 Check member limit before proceeding
    try {
      await this.usageService.enforceMemberLimit(workspaceId);
    } catch (error) {
      // If no usage record exists, skip the check (workspace may not have subscription yet)
      if (error.status !== 404) {
        throw error;
      }
    }

    // 2. Get owner's email to check if inviting themselves
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, workspaceData.ownerId),
    });

    if (owner?.email === inviteMemberDto.email) {
      throw new ConflictException('User is already the workspace owner');
    }

    // 3. Check if user exists
    const userToInvite = await this.db.query.users.findFirst({
      where: eq(users.email, inviteMemberDto.email),
    });

    // 4. If user exists, check if already a member (check ACCEPTED invitations)
    if (userToInvite) {
      const existingMember = await this.db.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.userId, userToInvite.id),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      });

      if (existingMember) {
        throw new ConflictException(
          'User is already a member of this workspace',
        );
      }
    }

    // 5. Check if there's already a pending invitation
    const existingInvitation =
      await this.db.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.email, inviteMemberDto.email),
          eq(workspaceInvitation.status, 'PENDING'),
        ),
      });

    if (existingInvitation) {
      throw new ConflictException(
        'An invitation has already been sent to this email',
      );
    }

    // 6. Generate unique token
    const token = crypto.randomBytes(32).toString('hex');

    // 7. Set expiration (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // 8. Create invitation - FIX: Cast role to match enum type
    const [invitation] = await this.db
      .insert(workspaceInvitation)
      .values({
        workspaceId,
        email: inviteMemberDto.email,
        userId: userToInvite?.id || null,
        role: (inviteMemberDto.role || MemberRole.MEMBER) as
          | 'ADMIN'
          | 'MEMBER'
          | 'GUEST',
        invitedBy: currentUserId,
        token,
        expiresAt,
      })
      .returning();

    // Send the invitation email (best-effort — the row exists regardless; resend covers retries)
    const workspaceName = workspaceData.name ?? 'your workspace';
    const inviterUser = await this.db.query.users.findFirst({
      where: eq(users.id, currentUserId),
      columns: { name: true },
    });
    try {
      await this.emailService.sendWorkspaceInvitation(inviteMemberDto.email, {
        workspaceName,
        inviterName: inviterUser?.name ?? undefined,
        role: invitation.role as 'ADMIN' | 'MEMBER' | 'GUEST',
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      });
    } catch (err) {
      console.error('Failed to send invitation email:', err);
    }

    return {
      message: 'Invitation sent successfully',
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        // Don't return token in production - security risk
        // token: invitation.token,
      },
    };
  }

  // Step 1b: Batch invite (seat-gated up front)
  async batchInvite(
    workspaceId: string,
    invites: { email: string; role?: 'ADMIN' | 'MEMBER' | 'GUEST' }[],
    currentUserId: string,
  ) {
    // permission: owner or admin (same check as inviteMember)
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });
    if (!workspaceData) throw new NotFoundException('Workspace not found');
    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only workspace owner or admins can invite members',
      );
    }

    // seat gate: reserved = accepted members + pending invitations
    let membersLimit = 0;
    let membersCount = 0;
    try {
      const usage = await this.usageService.getWorkspaceUsage(workspaceId);
      membersLimit = usage.membersLimit;
      membersCount = usage.membersCount;
    } catch (error) {
      // If no usage record exists, treat as no seats available (matches
      // enforceMemberLimit's 404-tolerance style, but conservatively for a gate)
      if (error.status !== 404) {
        throw error;
      }
    }

    const pending = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.status, 'PENDING'),
      ),
    });
    const reserved = membersCount + pending.length;
    if (reserved + invites.length > membersLimit) {
      const available = Math.max(0, membersLimit - reserved);
      throw new ForbiddenException(
        `SEAT_LIMIT_EXCEEDED: ${available} seat(s) left, ${invites.length} requested`,
      );
    }

    // create each invite (reuse inviteMember for validation + email); collect results
    const results: {
      email: string;
      status: 'invited' | 'skipped';
      reason?: string;
    }[] = [];
    for (const item of invites) {
      try {
        await this.inviteMember(
          workspaceId,
          { email: item.email, role: item.role } as any,
          currentUserId,
        );
        results.push({ email: item.email, status: 'invited' });
      } catch (e: any) {
        results.push({
          email: item.email,
          status: 'skipped',
          reason: e?.message ?? 'skipped',
        });
      }
    }
    return { results };
  }

  // Step 2: Accept invitation
  async acceptInvitation(token: string, currentUserId: string) {
    // 1. Find invitation by token
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.token, token),
      with: {
        workspace: true,
        inviter: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // 2. Check if invitation is still pending
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(
        `This invitation has already been ${invitation.status.toLowerCase()}`,
      );
    }

    // 3. Check if invitation has expired
    if (new Date() > invitation.expiresAt) {
      // Update status to expired
      await this.db
        .update(workspaceInvitation)
        .set({ status: 'EXPIRED' })
        .where(eq(workspaceInvitation.id, invitation.id));

      throw new BadRequestException('This invitation has expired');
    }

    // 4. Get current user's email
    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, currentUserId),
    });

    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    // 5. Check if invitation email matches current user
    if (currentUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException(
        'This invitation was sent to a different email address',
      );
    }

    // 6. Check if user is already a member (check for ACCEPTED invitations)
    const existingMember = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, invitation.workspaceId),
        eq(workspaceInvitation.userId, currentUserId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });

    if (existingMember) {
      throw new ConflictException('You are already a member of this workspace');
    }

    // 7. Update invitation status to ACCEPTED (don't create new record)
    const [acceptedInvitation] = await this.db
      .update(workspaceInvitation)
      .set({
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        userId: currentUserId, // Link invitation to user
        updatedAt: new Date(),
      })
      .where(eq(workspaceInvitation.id, invitation.id))
      .returning();

    // 8. Track usage - increment member count
    try {
      await this.usageService.incrementMemberCount(
        invitation.workspaceId,
        currentUserId,
        currentUserId,
      );
    } catch (error) {
      // Log but don't fail if usage tracking fails
      console.error('Failed to track member usage:', error);
    }

    // 9. Auto-verify email + complete onboarding — accepting this invitation
    // already proved inbox ownership (matching email + high-entropy token),
    // so an invited user skips the verify-email and create-workspace steps.
    try {
      await this.usersService.verifyEmail(currentUserId);
      await this.usersService.markOnboardingCompleted(currentUserId);
    } catch (error) {
      // Log but don't fail — the invitation is already committed above, so
      // a stamp failure here must never surface as a failed accept.
      console.error(
        `post-accept verify/onboarding stamp failed for user ${currentUserId}:`,
        error,
      );
    }

    return {
      message: 'Invitation accepted successfully',
      workspace: invitation.workspace,
      member: acceptedInvitation,
    };
  }

  // Step 3: Reject invitation
  async rejectInvitation(token: string, currentUserId: string) {
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.token, token),
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('This invitation is no longer pending');
    }

    // Get current user's email
    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, currentUserId),
    });

    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    if (currentUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException(
        'This invitation was sent to a different email address',
      );
    }

    await this.db
      .update(workspaceInvitation)
      .set({
        status: 'REJECTED',
        updatedAt: new Date(),
      })
      .where(eq(workspaceInvitation.id, invitation.id));

    return { message: 'Invitation rejected' };
  }

  // Get pending invitations for a workspace
  async getPendingInvitations(workspaceId: string, currentUserId: string) {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only workspace owner or admins can view invitations',
      );
    }

    const invitations = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.status, 'PENDING'),
      ),
      with: {
        inviter: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: (workspaceInvitation, { desc }) => [
        desc(workspaceInvitation.createdAt),
      ],
    });

    return invitations;
  }

  // Get user's pending invitations (invitations sent to them)
  async getMyInvitations(userId: string) {
    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    const invitations = await this.db.query.workspaceInvitation.findMany({
      where: and(
        sql`lower(${workspaceInvitation.email}) = ${currentUser.email.toLowerCase()}`,
        eq(workspaceInvitation.status, 'PENDING'),
      ),
      with: {
        workspace: { columns: { id: true, name: true } },
        inviter: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: (workspaceInvitation, { desc }) => [
        desc(workspaceInvitation.createdAt),
      ],
    });

    return invitations;
  }

  // Cancel invitation (only inviter, owner, or admin)
  async cancelInvitation(
    workspaceId: string,
    invitationId: string,
    currentUserId: string,
  ) {
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.id, invitationId),
        eq(workspaceInvitation.workspaceId, workspaceId),
      ),
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);
    const isInviter = invitation.invitedBy === currentUserId;
    const isSuperAdmin = await this.isPlatformSuperAdmin(currentUserId);

    if (!isOwner && !isAdmin && !isInviter && !isSuperAdmin) {
      throw new ForbiddenException(
        'You do not have permission to cancel this invitation',
      );
    }

    await this.db
      .delete(workspaceInvitation)
      .where(eq(workspaceInvitation.id, invitationId));

    return { message: 'Invitation cancelled' };
  }

  // ==================== EXISTING MEMBER MANAGEMENT ====================

  // Get all members (only ACCEPTED invitations)
  async getMembers(workspaceId: string, currentUserId: string) {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    // Get owner details
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, workspaceData.ownerId),
      columns: {
        id: true,
        name: true,
        email: true,
      },
    });

    const isOwner = workspaceData.ownerId === currentUserId;
    const isMember = await this.isUserMember(workspaceId, currentUserId);

    if (!isOwner && !isMember) {
      throw new ForbiddenException('You do not have access to this workspace');
    }

    // Only get ACCEPTED invitations (actual members)
    const members = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
        inviter: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: (workspaceInvitation, { desc }) => [
        desc(workspaceInvitation.acceptedAt),
      ],
    });

    return {
      owner,
      members,
      totalMembers: members.length + 1, // +1 for owner
    };
  }

  // Update member role (only for ACCEPTED members)
  async updateMemberRole(
    workspaceId: string,
    memberId: string,
    updateMemberDto: UpdateMemberDto,
    currentUserId: string,
  ) {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);
    const isSuperAdmin = await this.isPlatformSuperAdmin(currentUserId);

    if (!isOwner && !isAdmin && !isSuperAdmin) {
      throw new ForbiddenException(
        'Only workspace owner or admins can update member roles',
      );
    }

    const member = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.id, memberId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });

    if (!member) {
      throw new NotFoundException('Member not found in this workspace');
    }

    const [updatedMember] = await this.db
      .update(workspaceInvitation)
      .set({
        role: updateMemberDto.role as 'ADMIN' | 'MEMBER' | 'GUEST',
        updatedAt: new Date(),
      })
      .where(eq(workspaceInvitation.id, memberId))
      .returning();

    return updatedMember;
  }

  // Remove member (only ACCEPTED members)
  async removeMember(
    workspaceId: string,
    memberId: string,
    currentUserId: string,
  ) {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const member = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.id, memberId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });

    if (!member) {
      throw new NotFoundException('Member not found in this workspace');
    }

    const isOwner = workspaceData.ownerId === currentUserId;
    const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);
    const isSelf = member.userId === currentUserId;
    const isSuperAdmin = await this.isPlatformSuperAdmin(currentUserId);

    if (!isSelf && !isOwner && !isAdmin && !isSuperAdmin) {
      throw new ForbiddenException(
        'You do not have permission to remove this member',
      );
    }

    await this.db
      .delete(workspaceInvitation)
      .where(eq(workspaceInvitation.id, memberId));

    // Track usage - decrement member count
    try {
      await this.usageService.decrementMemberCount(
        workspaceId,
        currentUserId,
        member.userId || undefined,
      );
    } catch (error) {
      // Log but don't fail if usage tracking fails
      console.error('Failed to track member removal:', error);
    }

    return { message: 'Member removed successfully' };
  }

  // Public: minimal invitation info by token (no auth, no sensitive fields)
  async previewInvitation(token: string) {
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.token, token),
      with: {
        workspace: { columns: { name: true } },
        inviter: { columns: { name: true } },
      },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return {
      workspaceName: invitation.workspace?.name ?? 'a workspace',
      inviterName: invitation.inviter?.name ?? null,
      invitedEmail: invitation.email,
      role: invitation.role as 'ADMIN' | 'MEMBER' | 'GUEST',
      status: invitation.status as 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED',
      expired: new Date() > invitation.expiresAt,
    };
  }

  // Helper methods
  private async isUserMember(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const member = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });
    return !!member;
  }

  private async isUserAdmin(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const member = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
        eq(workspaceInvitation.role, 'ADMIN'),
      ),
    });
    return !!member;
  }

  /**
   * A platform super admin acting on a workspace they do not belong to.
   *
   * They are not a member and never will be, so every membership check in
   * this file refuses them. Support work — pulling a departed employee out of
   * an account, fixing a role the customer cannot reach themselves — still
   * has to run through these methods rather than around them: the usage
   * counters and side effects live here, and a second copy in the admin
   * module would drift out of step with this one.
   *
   * Deliberately narrow. It grants nothing to a workspace ADMIN, only to
   * SUPER_ADMIN, which is the role the admin dashboard's guard already
   * demands before any of this is reachable.
   */
  private async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { role: true },
    });

    return user?.role === 'SUPER_ADMIN';
  }
}
