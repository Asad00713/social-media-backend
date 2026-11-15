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
import { and, eq, gt, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { users, workspace, workspaceInvitation } from 'src/drizzle/schema';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MemberRole } from './dto/add-member.dto';
import { UsageService } from 'src/billing/services/usage.service';
import { EmailService } from 'src/email/email.service';
import { UsersService } from 'src/users/users.service';
import { WorkspaceRoleService } from './workspace-role.service';
import { normalizeEmail } from 'src/users/normalize-email';

/**
 * How long a removal can be undone (POST members/:memberId/restore). Long
 * enough for the Team page's Undo toast and a second thought; short enough
 * that a removal means removed.
 */
export const MEMBER_RESTORE_WINDOW_MS = 15 * 60 * 1000;

const RESTORE_WINDOW_MESSAGE =
  'A removal can only be undone within 15 minutes. Invite them again instead.';

/** A 409 with a machine-readable `code` the frontend reads. */
function memberConflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

/**
 * The row without its `token`. The token is the bearer secret of the accept
 * link; it leaves the server only in the invitation email, through
 * GET invitations/:invitationId/link (team:manage), and to the invitee
 * themselves on GET invitations/me — never in a team list or a member row.
 */
function withoutToken<T extends { token?: unknown }>(row: T): Omit<T, 'token'> {
  const rest: Partial<T> = { ...row };
  delete rest.token;
  return rest as Omit<T, 'token'>;
}

@Injectable()
export class WorkspaceMembersService {
  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private emailService: EmailService,
    private usersService: UsersService,
    private roleService: WorkspaceRoleService,
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

    // Accounts are stored lowercased now but older rows keep their typed case,
    // so every comparison below is case-insensitive on both sides.
    const email = normalizeEmail(inviteMemberDto.email);

    // 2. Get owner's email to check if inviting themselves
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, workspaceData.ownerId),
    });

    if (owner && normalizeEmail(owner.email) === email) {
      throw new ConflictException('User is already the workspace owner');
    }

    // 3. Check if user exists
    const userToInvite = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${email}`,
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
          sql`lower(${workspaceInvitation.email}) = ${email}`,
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
        email,
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
      await this.emailService.sendWorkspaceInvitation(email, {
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
    const free = await this.freeSeats(workspaceId);
    if (invites.length > free) {
      throw new ForbiddenException(
        `SEAT_LIMIT_EXCEEDED: ${Math.max(0, free)} seat(s) left, ${invites.length} requested`,
      );
    }

    // create each invite (reuse inviteMember for validation + email); collect results
    const results: {
      email: string;
      status: 'invited' | 'skipped';
      /** The new invitation, for the Invitation sent toast's Copy invite link. */
      invitationId?: string;
      reason?: string;
    }[] = [];
    for (const item of invites) {
      try {
        const created = await this.inviteMember(
          workspaceId,
          { email: item.email, role: item.role } as any,
          currentUserId,
        );
        results.push({
          email: item.email,
          status: 'invited',
          invitationId: created.invitation.id,
        });
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
      member: withoutToken(acceptedInvitation),
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
      // The token is the accept link's secret: Copy invite link reads it
      // through getInvitationLink, never from this list.
      columns: { token: false },
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
        lastLoginAt: true,
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
      columns: { token: false },
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
            lastLoginAt: true,
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

    return withoutToken(updatedMember);
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

    // Soft removal: the row is kept as REMOVED so the removal can be undone
    // (restoreMember). Every reader filters on ACCEPTED or PENDING, so a
    // REMOVED row grants no access, holds no seat and blocks no re-invite.
    // Conditional on ACCEPTED, so two concurrent removals decrement once.
    const now = new Date();
    const [removed] = await this.db
      .update(workspaceInvitation)
      .set({
        status: 'REMOVED',
        removedAt: now,
        removedBy: currentUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceInvitation.id, memberId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      )
      .returning({ id: workspaceInvitation.id });

    if (!removed) {
      throw new NotFoundException('Member not found in this workspace');
    }

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

  /**
   * Undo of a removal (the Team page's Undo toast). Only a member removed by
   * someone else (leaving on your own is final) within
   * MEMBER_RESTORE_WINDOW_MS, and only when a seat is free, counted exactly
   * as for an invitation. Restores ACCEPTED with the same role.
   *
   * Removal sends no notification or email, so nothing the removed person
   * was told needs taking back; they simply have access again.
   */
  async restoreMember(
    workspaceId: string,
    memberId: string,
    currentUserId: string,
  ) {
    const row = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.id, memberId),
        eq(workspaceInvitation.status, 'REMOVED'),
      ),
    });

    // Leaving on your own (removed_by = the member) is not undoable.
    if (!row || !row.userId || row.removedBy === row.userId) {
      throw new NotFoundException('Removed member not found in this workspace');
    }

    const windowStart = new Date(Date.now() - MEMBER_RESTORE_WINDOW_MS);
    if (!row.removedAt || row.removedAt <= windowStart) {
      throw memberConflict('RESTORE_WINDOW_PASSED', RESTORE_WINDOW_MESSAGE);
    }

    // Re-invited and already accepted since: there is nothing to restore.
    if (await this.isUserMember(workspaceId, row.userId)) {
      throw memberConflict(
        'ALREADY_MEMBER',
        'They are already a member of this workspace',
      );
    }

    // A pending re-invitation to the same address is replaced by the restore
    // (deleted below), so it does not count against the seat it would take.
    const email = normalizeEmail(row.email);
    const free = await this.freeSeats(workspaceId, email);
    if (free < 1) {
      throw memberConflict(
        'SEAT_LIMIT_EXCEEDED',
        'SEAT_LIMIT_EXCEEDED: 0 seat(s) left, 1 requested',
      );
    }

    // Conditional on still REMOVED and inside the window: two concurrent
    // restores (or one racing the window's end) restore and count once.
    const [restored] = await this.db
      .update(workspaceInvitation)
      .set({
        status: 'ACCEPTED',
        removedAt: null,
        removedBy: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceInvitation.id, row.id),
          eq(workspaceInvitation.status, 'REMOVED'),
          gt(workspaceInvitation.removedAt, windowStart),
        ),
      )
      .returning();

    if (!restored) {
      throw memberConflict('RESTORE_WINDOW_PASSED', RESTORE_WINDOW_MESSAGE);
    }

    await this.db
      .delete(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'PENDING'),
          sql`lower(${workspaceInvitation.email}) = ${email}`,
        ),
      );

    try {
      await this.usageService.incrementMemberCount(
        workspaceId,
        currentUserId,
        row.userId,
      );
    } catch (error) {
      // Log but don't fail if usage tracking fails (as accept and remove do)
      console.error('Failed to track member restore:', error);
    }

    return { message: 'Member restored', member: withoutToken(restored) };
  }

  /**
   * The accept URL of a pending, unexpired invitation of this workspace, for
   * the Team page's Copy invite link: the URL its email carries
   * (EmailService.invitationAcceptUrl). 404 for anything else: an accepted,
   * rejected, expired or removed row, or another workspace's.
   */
  async getInvitationLink(workspaceId: string, invitationId: string) {
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.id, invitationId),
        eq(workspaceInvitation.status, 'PENDING'),
      ),
      columns: { token: true, expiresAt: true },
    });

    if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('Invitation not found or no longer pending');
    }

    return {
      url: this.emailService.invitationAcceptUrl(invitation.token),
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Seats left: the member limit (with purchased extras) minus accepted
   * members and pending invitations, which reserve a seat each.
   * `exceptPendingTo` leaves out pending invitations to that normalized
   * address. No usage record reads as no seats, conservatively for a gate.
   */
  private async freeSeats(
    workspaceId: string,
    exceptPendingTo?: string,
  ): Promise<number> {
    let membersLimit = 0;
    let membersCount = 0;
    try {
      const usage = await this.usageService.getWorkspaceUsage(workspaceId);
      membersLimit = usage.membersLimit;
      membersCount = usage.membersCount;
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const pending = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.status, 'PENDING'),
      ),
      columns: { email: true },
    });
    const reservedByPending = exceptPendingTo
      ? pending.filter((p) => normalizeEmail(p.email) !== exceptPendingTo)
          .length
      : pending.length;
    return membersLimit - (membersCount + reservedByPending);
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
      status: invitation.status as
        | 'PENDING'
        | 'ACCEPTED'
        | 'REJECTED'
        | 'EXPIRED'
        | 'REMOVED',
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
    return this.roleService.isPlatformSuperAdmin(userId);
  }
}
