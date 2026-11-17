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
import { and, eq, gt, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
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

/**
 * How long a removal can be undone (POST members/:memberId/restore). Long
 * enough for the Team page's Undo toast and a second thought; short enough
 * that a removal means removed.
 */
export const MEMBER_RESTORE_WINDOW_MS = 15 * 60 * 1000;

/**
 * B3 waits out the undo window, plus a margin so an Undo pressed in its last
 * second still lands first. At send time the template checks the row is
 * still REMOVED by this removal (removedFromWorkspace.stillApplies).
 */
export const MEMBER_REMOVED_EMAIL_DELAY_MS = MEMBER_RESTORE_WINDOW_MS + 30_000;

/** An invitation lives 7 days from sending, and again from each resend. */
const INVITATION_TTL_DAYS = 7;

/** How long a lapsed invitation stays on the Team page, for Resend. */
const EXPIRED_INVITATION_VISIBLE_DAYS = 30;

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

/**
 * An invitation as the Team page lists it: no token, a computed status
 * (a PENDING row past its expiry reads EXPIRED, whatever the stored status
 * says) and the inviter's name flattened out.
 */
function invitationView<
  T extends {
    token?: unknown;
    status: string;
    expiresAt: Date;
    inviter?: { name: string | null } | null;
  },
>(row: T, now: number) {
  const lapsed = row.status === 'EXPIRED' || row.expiresAt.getTime() <= now;
  return {
    ...withoutToken(row),
    status: (lapsed ? 'EXPIRED' : 'PENDING') as 'PENDING' | 'EXPIRED',
    invitedByName: row.inviter?.name ?? null,
  };
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

    // Best-effort: the row exists regardless, and a failed send is logged.
    await this.sendInvitationEmail(
      invitation,
      workspaceData,
      currentUserId,
      invitation.userId ?? null,
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
    input: {
      email: string;
      role?: MemberRoleName;
      invitedBy: string;
      message?: string;
    },
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
    expiresAt.setDate(expiresAt.getDate() + INVITATION_TTL_DAYS);

    const [invitation] = await tx
      .insert(workspaceInvitation)
      .values({
        workspaceId,
        email,
        userId: userToInvite?.id || null,
        role: input.role || (MemberRole.MEMBER as MemberRoleName),
        invitedBy: input.invitedBy,
        message: input.message ?? null,
        token: crypto.randomBytes(32).toString('hex'),
        expiresAt,
      })
      .returning();
    return invitation;
  }

  // Step 1b: Batch invite (seat-gated up front)
  async batchInvite(
    workspaceId: string,
    invites: { email: string; role?: 'ADMIN' | 'MEMBER' | 'GUEST' }[],
    currentUserId: string,
    /** The inviter's personal note, stored on every row and put in each email. */
    message?: string,
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
              message,
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
          o.invitation,
          workspaceData,
          currentUserId,
          o.invitation.userId ?? null,
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

    await this.notifyInviterOfAcceptance(
      invitation,
      currentUser,
      acceptedInvitation,
    );

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

    // PENDING rows, and EXPIRED ones (stored, or PENDING past their expiry)
    // for 30 days after they lapsed, so a lapsed invite can be resent. The
    // cutoff is a JS Date: expires_at is a timestamp without zone, and the
    // driver writes a Date and compares it the same way.
    const now = Date.now();
    const invitations = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        or(
          eq(workspaceInvitation.status, 'PENDING'),
          eq(workspaceInvitation.status, 'EXPIRED'),
        ),
        gt(
          workspaceInvitation.expiresAt,
          new Date(now - EXPIRED_INVITATION_VISIBLE_DAYS * DAY_MS),
        ),
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

    return invitations.map((row) => invitationView(row, now));
  }

  /**
   * Resend: a fresh 7 days on the same link, and the email again. An EXPIRED
   * invitation (or a PENDING one past its expiry) reserves a seat again, so
   * it is seat-checked under the workspace's seat lock like any new invite;
   * a live PENDING one already holds its seat. Accepted, removed and rejected
   * rows are not invitations any more.
   */
  async resendInvitation(
    workspaceId: string,
    invitationId: string,
    currentUserId: string,
  ) {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });
    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }

    const resent = await this.db.transaction(async (tx) => {
      await lockWorkspaceSeats(tx, workspaceId);
      const row = await tx.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.id, invitationId),
          eq(workspaceInvitation.workspaceId, workspaceId),
        ),
      });
      if (!row) {
        throw new NotFoundException('Invitation not found');
      }
      if (row.status !== 'PENDING' && row.status !== 'EXPIRED') {
        throw memberConflict(
          'INVITATION_NOT_RESENDABLE',
          'Only an invitation that has not been answered can be resent.',
        );
      }

      const lapsed =
        row.status === 'EXPIRED' || row.expiresAt.getTime() <= Date.now();
      if (lapsed) {
        const email = normalizeEmail(row.email);
        // Never two live invitations to one address (createInvitation's rule).
        const sibling = await tx.query.workspaceInvitation.findFirst({
          where: and(
            eq(workspaceInvitation.workspaceId, workspaceId),
            sql`lower(${workspaceInvitation.email}) = ${email}`,
            eq(workspaceInvitation.status, 'PENDING'),
            ne(workspaceInvitation.id, row.id),
          ),
          columns: { id: true },
        });
        if (sibling) {
          throw memberConflict(
            'INVITATION_ALREADY_PENDING',
            'An invitation has already been sent to this email',
          );
        }
        // A lapsed PENDING row is counted by freeSeats already; leaving this
        // address out makes both kinds of lapsed row ask for the seat anew.
        const free = await this.freeSeats(workspaceId, email, tx);
        if (free < 1) throw seatLimitExceeded(free, 1);
      }

      const [updated] = await tx
        .update(workspaceInvitation)
        .set({
          status: 'PENDING',
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS),
          updatedAt: new Date(),
        })
        .where(eq(workspaceInvitation.id, row.id))
        .returning();
      return updated;
    });

    // Best-effort, like the first send: the new expiry is saved either way.
    // The note and the name on it stay the original inviter's.
    await this.sendInvitationEmail(
      resent,
      workspaceData,
      resent.invitedBy ?? currentUserId,
      resent.userId ?? null,
    );

    const view = await this.db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.id, resent.id),
      columns: { token: false },
      with: { inviter: { columns: { id: true, name: true, email: true } } },
    });
    return invitationView(view ?? { ...resent, inviter: null }, Date.now());
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

    // lastActiveAt is the last sign-in, as an ISO string for the Team page.
    return {
      owner: owner
        ? { ...owner, lastActiveAt: owner.lastLoginAt?.toISOString() ?? null }
        : owner,
      members: members.map((m) => ({
        ...m,
        lastActiveAt: m.user?.lastLoginAt?.toISOString() ?? null,
      })),
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

    if (member.userId && member.userId !== currentUserId) {
      // After the conditional update above, so a removal emails once even
      // when two removals race.
      await this.notifyMemberRemoved(
        workspaceData,
        { id: memberId, userId: member.userId, removedAt: now },
        currentUserId,
      );
    }

    return { message: 'Member removed successfully' };
  }

  /**
   * The caller leaves a workspace (DELETE members/me), at any role. Resolves
   * their own ACCEPTED row and removes it through removeMember's self path, so
   * the row is kept as REMOVED with removed_by = the caller (never restorable)
   * and the seat is released.
   *
   * The owner cannot leave: there is no transfer, so a workspace without its
   * owner would be orphaned. They delete the workspace instead. Checked BEFORE
   * the row lookup, because the owner holds no membership row and would
   * otherwise get a misleading 404.
   */
  async leaveWorkspace(workspaceId: string, userId: string): Promise<void> {
    const workspaceData = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { ownerId: true },
    });
    if (!workspaceData) {
      throw new NotFoundException('Workspace not found');
    }
    if (workspaceData.ownerId === userId) {
      throw memberConflict(
        'OWNER_CANNOT_LEAVE',
        'The owner cannot leave their own workspace. Delete the workspace instead.',
      );
    }

    const row = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
      columns: { id: true },
    });
    if (!row) {
      throw new NotFoundException('You are not a member of this workspace');
    }

    await this.removeMember(workspaceId, row.id, userId);
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
   * A removal by someone else rings the removed person's bell at once and
   * queues the B3 "removed from workspace" email for after this window; a
   * restore drops that email (its send-time check finds the row ACCEPTED) and
   * sends nothing back, they simply have access again.
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
   * (AppLinks.invite). 404 for anything else: an accepted,
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
      url: this.links.invite(invitation.token),
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
          message: invitation.message ?? null,
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
      // NULL once the inviter's account was deleted (0091): nobody to tell.
      invitedBy: string | null;
      workspace: { name: string; timezone?: string | null };
    },
    member: { id: string; name: string | null; email: string },
    accepted: { role: 'ADMIN' | 'MEMBER' | 'GUEST'; acceptedAt: Date | null },
  ): Promise<void> {
    try {
      const inviterId = invitation.invitedBy;
      if (inviterId === null || inviterId === member.id) return;
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

  /**
   * The bell now and B3 after the undo window, to the member who was removed.
   * Never throws.
   */
  private async notifyMemberRemoved(
    workspaceData: {
      id: string;
      name: string | null;
      timezone?: string | null;
    },
    removal: { id: string; userId: string; removedAt: Date },
    removedById: string,
  ): Promise<void> {
    const removedUserId = removal.userId;
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
            removedOn: formatDay(
              removal.removedAt,
              workspaceData.timezone || 'UTC',
            ),
            openUrl: this.links.frontend('/'),
            membershipId: removal.id,
            removedAtMs: removal.removedAt.getTime(),
          },
          delayMs: MEMBER_REMOVED_EMAIL_DELAY_MS,
          // One per removal: the row and the moment it was marked REMOVED.
          idempotencyKey: `member-removed.${removal.id}.${removal.removedAt.getTime()}`,
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
