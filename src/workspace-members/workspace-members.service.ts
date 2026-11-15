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
import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
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

/** The db, or a transaction on it: the readers below run in either. */
type Tx = Parameters<Parameters<DbType['transaction']>[0]>[0];
type Queryable = DbType | Tx;

type MemberRoleName = 'ADMIN' | 'MEMBER' | 'GUEST';

/**
 * Serialises every write that takes a seat in one workspace (invite, batch
 * invite, accept, restore) for the rest of the caller's transaction. The seat
 * check reads `workspace_usage` and the PENDING rows; without this two
 * concurrent writers both see the last free seat. Released when the
 * transaction ends, so callers MUST be inside one.
 */
async function lockWorkspaceSeats(
  tx: { execute: (query: SQL) => Promise<unknown> },
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('workspace-seats:' || ${workspaceId}::text, 0))`,
  );
}

function seatLimitExceeded(
  free: number,
  requested: number,
): ForbiddenException {
  return new ForbiddenException(
    `SEAT_LIMIT_EXCEEDED: ${Math.max(0, free)} seat(s) left, ${requested} requested`,
  );
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

    // Seat gate and insert under the workspace's seat lock, so two invites
    // racing for the last seat cannot both get it. Same gate as batch invite:
    // accepted members + pending invitations against the limit.
    const invitation = await this.db.transaction(async (tx) => {
      await lockWorkspaceSeats(tx, workspaceId);
      const free = await this.freeSeats(workspaceId, undefined, tx);
      if (free < 1) throw seatLimitExceeded(free, 1);
      return this.createInvitation(tx, workspaceData.ownerId, workspaceId, {
        email: inviteMemberDto.email,
        role: inviteMemberDto.role as MemberRoleName | undefined,
        invitedBy: currentUserId,
      });
    });

    await this.sendInvitationEmail(
      workspaceData.name ?? 'your workspace',
      invitation,
      currentUserId,
    );

    return {
      message: 'Invitation sent successfully',
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    };
  }

  /**
   * Validates and inserts one invitation (no email, no seat check: the caller
   * holds the seat lock and has checked). Throws ConflictException for the
   * owner, an existing member or an already pending invitation.
   */
  private async createInvitation(
    tx: Queryable,
    ownerId: string,
    workspaceId: string,
    input: { email: string; role?: MemberRoleName; invitedBy: string },
  ) {
    // Accounts are stored lowercased now but older rows keep their typed case,
    // so every comparison below is case-insensitive on both sides.
    const email = normalizeEmail(input.email);

    const owner = await tx.query.users.findFirst({
      where: eq(users.id, ownerId),
    });
    if (owner && normalizeEmail(owner.email) === email) {
      throw new ConflictException('User is already the workspace owner');
    }

    const userToInvite = await tx.query.users.findFirst({
      where: sql`lower(${users.email}) = ${email}`,
    });

    if (userToInvite) {
      const existingMember = await tx.query.workspaceInvitation.findFirst({
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

    const existingInvitation = await tx.query.workspaceInvitation.findFirst({
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

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const [invitation] = await tx
      .insert(workspaceInvitation)
      .values({
        workspaceId,
        email,
        userId: userToInvite?.id || null,
        role: input.role || (MemberRole.MEMBER as MemberRoleName),
        invitedBy: input.invitedBy,
        token: crypto.randomBytes(32).toString('hex'),
        expiresAt,
      })
      .returning();
    return invitation;
  }

  /** The invitation email, best-effort: the row exists regardless and resend covers retries. */
  private async sendInvitationEmail(
    workspaceName: string,
    invitation: { email: string; role: string; token: string; expiresAt: Date },
    inviterId: string,
  ): Promise<void> {
    try {
      const inviterUser = await this.db.query.users.findFirst({
        where: eq(users.id, inviterId),
        columns: { name: true },
      });
      await this.emailService.sendWorkspaceInvitation(invitation.email, {
        workspaceName,
        inviterName: inviterUser?.name ?? undefined,
        role: invitation.role as MemberRoleName,
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      });
    } catch (err) {
      console.error('Failed to send invitation email:', err);
    }
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

    // Seat gate and every insert under the workspace's seat lock (one
    // transaction; each invite in its own savepoint, so one refusal skips
    // only that address). Emails go out after the commit.
    const outcomes = await this.db.transaction(async (tx) => {
      await lockWorkspaceSeats(tx, workspaceId);
      const free = await this.freeSeats(workspaceId, undefined, tx);
      if (invites.length > free) {
        throw seatLimitExceeded(free, invites.length);
      }

      const out: {
        email: string;
        invitation?: Awaited<
          ReturnType<WorkspaceMembersService['createInvitation']>
        >;
        reason?: string;
      }[] = [];
      for (const item of invites) {
        try {
          const invitation = await tx.transaction((sp) =>
            this.createInvitation(sp, workspaceData.ownerId, workspaceId, {
              email: item.email,
              role: item.role,
              invitedBy: currentUserId,
            }),
          );
          out.push({ email: item.email, invitation });
        } catch (e: any) {
          out.push({ email: item.email, reason: e?.message ?? 'skipped' });
        }
      }
      return out;
    });

    const results: {
      email: string;
      status: 'invited' | 'skipped';
      /** The new invitation, for the Invitation sent toast's Copy invite link. */
      invitationId?: string;
      reason?: string;
    }[] = [];
    for (const o of outcomes) {
      if (o.invitation) {
        await this.sendInvitationEmail(
          workspaceData.name ?? 'your workspace',
          o.invitation,
          currentUserId,
        );
        results.push({
          email: o.email,
          status: 'invited',
          invitationId: o.invitation.id,
        });
      } else {
        results.push({ email: o.email, status: 'skipped', reason: o.reason });
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

    // 6-8. Under the workspace's seat lock (a concurrent restore of the same
    // person serialises here): not already a member, the row still PENDING,
    // then counted once.
    const acceptedInvitation = await this.db.transaction(async (tx) => {
      await lockWorkspaceSeats(tx, invitation.workspaceId);

      const existingMember = await tx.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.workspaceId, invitation.workspaceId),
          eq(workspaceInvitation.userId, currentUserId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      });
      if (existingMember) {
        throw new ConflictException(
          'You are already a member of this workspace',
        );
      }

      const [accepted] = await tx
        .update(workspaceInvitation)
        .set({
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          userId: currentUserId, // Link invitation to user
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaceInvitation.id, invitation.id),
            eq(workspaceInvitation.status, 'PENDING'),
          ),
        )
        .returning();
      if (!accepted) {
        throw new BadRequestException('This invitation is no longer pending');
      }

      // Counted before the lock is released, so the next seat check sees it.
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
      return accepted;
    });

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
    // Only an invitation, never a member row: an ACCEPTED row goes through
    // removeMember (which counts the seat), and a REMOVED one must stay
    // until its undo window has passed.
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.id, invitationId),
        eq(workspaceInvitation.workspaceId, workspaceId),
        inArray(workspaceInvitation.status, ['PENDING', 'REJECTED', 'EXPIRED']),
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
        // The old accept link dies with the membership: the row stays as
        // history, its token replaced by one nobody was ever sent.
        token: crypto.randomBytes(32).toString('hex'),
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
   * someone else (leaving on your own is final), within
   * MEMBER_RESTORE_WINDOW_MS, and only by the person who removed them, the
   * workspace owner or a platform super admin. Seat-gated as an invitation.
   * Restores ACCEPTED with the same role.
   *
   * A pending re-invitation to the same address, whatever its role, is
   * deleted and returned in `droppedInvitations`: the restored membership
   * replaces it.
   *
   * Removal sends no notification or email, so nothing the removed person
   * was told needs taking back; they simply have access again.
   */
  async restoreMember(
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
    const userId = row.userId;

    const isRemover = row.removedBy === currentUserId;
    const isOwner = workspaceData.ownerId === currentUserId;
    if (
      !isRemover &&
      !isOwner &&
      !(await this.isPlatformSuperAdmin(currentUserId))
    ) {
      throw new ForbiddenException(
        'Only the person who removed them or the workspace owner can undo this removal',
      );
    }

    const windowStart = new Date(Date.now() - MEMBER_RESTORE_WINDOW_MS);
    if (!row.removedAt || row.removedAt <= windowStart) {
      throw memberConflict('RESTORE_WINDOW_PASSED', RESTORE_WINDOW_MESSAGE);
    }

    const email = normalizeEmail(row.email);
    const alreadyMember = () =>
      memberConflict(
        'ALREADY_MEMBER',
        'They are already a member of this workspace',
      );

    // One transaction under the workspace's seat lock (accept and invite take
    // it too): seat check, restore, dropping the re-invitation and counting
    // the seat happen with nobody else changing seats in between.
    const { restored, dropped } = await this.db.transaction(async (tx) => {
      await lockWorkspaceSeats(tx, workspaceId);

      if (await this.isUserMember(workspaceId, userId, tx)) {
        throw alreadyMember();
      }

      // The re-invitation deleted below does not hold a seat against this.
      const free = await this.freeSeats(workspaceId, email, tx);
      if (free < 1) {
        throw memberConflict(
          'SEAT_LIMIT_EXCEEDED',
          'SEAT_LIMIT_EXCEEDED: 0 seat(s) left, 1 requested',
        );
      }

      // Conditional on: still REMOVED, inside the window, and nobody with
      // this user or address ACCEPTED in the workspace (a re-invite accepted
      // meanwhile). Two concurrent restores restore and count once.
      const [restoredRow] = await tx
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
            sql`NOT EXISTS (
              SELECT 1 FROM ${workspaceInvitation} AS other
              WHERE other.workspace_id = ${workspaceId}
                AND other.status = 'ACCEPTED'
                AND (other.user_id = ${userId} OR lower(other.email) = ${email})
            )`,
          ),
        )
        .returning();

      if (!restoredRow) {
        if (await this.isUserMember(workspaceId, userId, tx)) {
          throw alreadyMember();
        }
        throw memberConflict('RESTORE_WINDOW_PASSED', RESTORE_WINDOW_MESSAGE);
      }

      const droppedRows = await tx
        .delete(workspaceInvitation)
        .where(
          and(
            eq(workspaceInvitation.workspaceId, workspaceId),
            eq(workspaceInvitation.status, 'PENDING'),
            sql`lower(${workspaceInvitation.email}) = ${email}`,
          ),
        )
        .returning({
          id: workspaceInvitation.id,
          email: workspaceInvitation.email,
          role: workspaceInvitation.role,
        });

      // Counted before the lock is released, so the next seat check sees it.
      try {
        await this.usageService.incrementMemberCount(
          workspaceId,
          currentUserId,
          userId,
        );
      } catch (error) {
        // Log but don't fail if usage tracking fails (as accept and remove do)
        console.error('Failed to track member restore:', error);
      }

      return { restored: restoredRow, dropped: droppedRows };
    });

    return {
      message: 'Member restored',
      member: withoutToken(restored),
      droppedInvitations: dropped,
    };
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
    q: Queryable = this.db,
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

    const pending = await q.query.workspaceInvitation.findMany({
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
    q: Queryable = this.db,
  ): Promise<boolean> {
    const member = await q.query.workspaceInvitation.findFirst({
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
