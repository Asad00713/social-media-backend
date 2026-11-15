// src/workspace-members/workspace-members.service.ts
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { and, eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { InviteMemberDto } from './dto/invite-member.dto';
import {
  socialMediaChannels,
  users,
  workspace,
  workspaceInvitation,
} from 'src/drizzle/schema';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MemberRole } from './dto/add-member.dto';
import { UsageService } from 'src/billing/services/usage.service';
import { AppLinks } from 'src/email/links/app-links';
import { formatDay } from 'src/email/links/format-when';
import { EmailOutboxService } from 'src/email/queue/email-outbox.service';
import { invitationAccepted } from 'src/email/templates/team/invitation-accepted';
import { removedFromWorkspace } from 'src/email/templates/team/removed-from-workspace';
import { workspaceInvitation as workspaceInvitationEmail } from 'src/email/templates/team/workspace-invitation';
import { NotificationEmitterService } from 'src/notifications/notification-emitter.service';
import { NotifyService } from 'src/notifications/notify.service';
import { RecipientsService } from 'src/notifications/recipients.service';
import { UsersService } from 'src/users/users.service';
import { WorkspaceRoleService } from './workspace-role.service';
import { normalizeEmail } from 'src/users/normalize-email';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WorkspaceMembersService {
  private readonly logger = new Logger(WorkspaceMembersService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private emailOutbox: EmailOutboxService,
    private usersService: UsersService,
    private roleService: WorkspaceRoleService,
    private notifyService: NotifyService,
    private notifications: NotificationEmitterService,
    private recipients: RecipientsService,
    private links: AppLinks,
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

    // Best-effort: the row exists regardless, and a failed send is logged.
    await this.sendInvitationEmail(
      invitation,
      workspaceData,
      currentUserId,
      userToInvite?.id ?? null,
    );

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

    await this.notifyInviterOfAcceptance(
      invitation,
      currentUser,
      acceptedInvitation,
    );

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

    if (member.userId && member.userId !== currentUserId) {
      await this.notifyMemberRemoved(
        workspaceData,
        member.userId,
        currentUserId,
      );
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

  // ==================== EMAIL ====================

  /**
   * B1. Sent inline, not queued: the props carry the invite token, which must
   * not sit in Redis. Never throws: the invitation already exists.
   */
  private async sendInvitationEmail(
    invitation: typeof workspaceInvitation.$inferSelect,
    workspaceData: { id: string; name: string | null },
    inviterId: string,
    inviteeUserId: string | null,
  ): Promise<void> {
    try {
      const [inviter, channels, members] = await Promise.all([
        this.recipients.user(inviterId),
        this.countConnectedChannels(workspaceData.id),
        this.countMembers(workspaceData.id),
      ]);
      const result = await this.emailOutbox.sendNow({
        template: workspaceInvitationEmail,
        props: {
          inviterName: inviter
            ? this.recipients.displayName(inviter)
            : 'A teammate',
          inviterEmail: inviter?.email ?? '',
          workspaceName: workspaceData.name ?? 'your workspace',
          role: invitation.role,
          channels,
          members,
          acceptUrl: this.links.invite(invitation.token),
          inviteeEmail: invitation.email,
          expiresInDays: Math.max(
            1,
            Math.round((invitation.expiresAt.getTime() - Date.now()) / DAY_MS),
          ),
        },
        to: { email: invitation.email, userId: inviteeUserId },
        workspaceId: workspaceData.id,
        idempotencyKey: `invite.${invitation.id}.${invitation.expiresAt.getTime()}`,
      });
      if (!result.success) {
        this.logger.warn(
          // The error text can quote the address, so only its code is logged.
          `Invitation email ${invitation.id} not sent (${result.errorCode ?? 'send failed'})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Invitation email ${invitation.id} failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /** B2 and its bell, to whoever invited the member. Never throws. */
  private async notifyInviterOfAcceptance(
    invitation: {
      id: string;
      workspaceId: string;
      invitedBy: string;
      workspace: { name: string; timezone?: string | null };
    },
    member: { id: string; name: string | null; email: string },
    accepted: { role: 'ADMIN' | 'MEMBER' | 'GUEST'; acceptedAt: Date | null },
  ): Promise<void> {
    try {
      const inviterId = invitation.invitedBy;
      if (inviterId === member.id) return;
      const memberName = this.recipients.displayName(member);
      const workspaceName = invitation.workspace.name;
      await this.notifyService.notify({
        userId: inviterId,
        workspaceId: invitation.workspaceId,
        event: 'member_activity',
        bell: () =>
          this.notifications.invitationAccepted(
            inviterId,
            memberName,
            workspaceName,
          ),
        email: {
          template: invitationAccepted,
          props: {
            memberName,
            memberEmail: member.email,
            workspaceName,
            role: accepted.role,
            joined: formatDay(
              accepted.acceptedAt ?? new Date(),
              invitation.workspace.timezone || 'UTC',
            ),
            membersUrl: this.links.members(invitation.workspaceId),
          },
          idempotencyKey: `invite-accepted.${invitation.id}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Accepted-invitation notice ${invitation.id} failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /** B3 and its bell, to the member who was removed. Never throws. */
  private async notifyMemberRemoved(
    workspaceData: {
      id: string;
      name: string | null;
      timezone?: string | null;
    },
    removedUserId: string,
    removedById: string,
  ): Promise<void> {
    try {
      const remover = await this.recipients.user(removedById);
      const removedByName = remover
        ? this.recipients.displayName(remover)
        : 'A workspace admin';
      const workspaceName = workspaceData.name ?? 'the workspace';
      await this.notifyService.notify({
        userId: removedUserId,
        workspaceId: workspaceData.id,
        event: null,
        bell: () =>
          this.notifications.memberRemoved(
            removedUserId,
            workspaceName,
            removedByName,
          ),
        email: {
          template: removedFromWorkspace,
          props: {
            workspaceName,
            removedByName,
            removedOn: formatDay(new Date(), workspaceData.timezone || 'UTC'),
            openUrl: this.links.frontend('/'),
          },
          idempotencyKey: `member-removed.${workspaceData.id}.${removedUserId}.${Date.now()}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Member-removed notice for workspace ${workspaceData.id} failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  private async countConnectedChannels(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
        ),
      );
    return row?.count ?? 0;
  }

  /** Accepted members plus the owner, who has no invitation row. */
  private async countMembers(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      );
    return (row?.count ?? 0) + 1;
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
