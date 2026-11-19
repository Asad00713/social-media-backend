// src/workspace-members/invite-link.service.ts
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { users, workspace, workspaceInvitation } from 'src/drizzle/schema';
import { UsageService } from 'src/billing/services/usage.service';
import { AppLinks } from 'src/email/links/app-links';
import { normalizeEmail } from 'src/users/normalize-email';
import { liveWorkspaces } from 'src/posts/soft-delete/soft-delete';
import {
  lockWorkspaceSeats,
  WorkspaceMembersService,
} from './workspace-members.service';

/** Crockford base32, lower case: no i, l, o or u, so a code reads aloud. */
export const INVITE_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** `{initials}-{10 symbols}`, e.g. `rw-7k2m9x4qpd`. */
export const INVITE_CODE_REGEX = /^[a-z0-9]{1,2}-[0-9a-hjkmnp-tv-z]{10}$/;

/** 10 symbols x 5 bits = 50 bits from the CSPRNG. */
const CODE_SYMBOLS = 10;

/**
 * One generic message for every way a code can fail to open a workspace
 * (never issued, reset, disabled, suspended workspace): a caller learns
 * nothing about which workspaces exist.
 */
const NOT_FOUND_MESSAGE = 'Invite link not found';

export interface InviteLinkState {
  enabled: boolean;
  url: string | null;
}

/** A 409 with the machine-readable `code` the frontend reads. */
function joinConflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

/**
 * The first ASCII letter or digit of each of the first two words, lowercased.
 * `ws` when the name has none (empty, symbols only, non-Latin script).
 */
function initialsOf(workspaceName: string): string {
  const initials = workspaceName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.match(/[A-Za-z0-9]/)?.[0] ?? '')
    .join('')
    .toLowerCase();
  return initials || 'ws';
}

/**
 * A fresh invite code for a workspace. `random` is injectable for tests; the
 * default is `crypto.randomBytes`. A byte is reduced with `& 31`: 256 is a
 * multiple of 32, so every symbol is equally likely.
 */
export function generateInviteCode(
  workspaceName: string,
  random: (n: number) => Buffer = crypto.randomBytes,
): string {
  const bytes = random(CODE_SYMBOLS);
  let suffix = '';
  for (let i = 0; i < CODE_SYMBOLS; i++) {
    suffix += INVITE_CODE_ALPHABET[bytes[i] & 31];
  }
  return `${initialsOf(workspaceName)}-${suffix}`;
}

/** Postgres unique_violation, bare or wrapped by drizzle as `cause`. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

@Injectable()
export class InviteLinkService {
  private readonly logger = new Logger(InviteLinkService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private membersService: WorkspaceMembersService,
    private links: AppLinks,
  ) {}

  async get(workspaceId: string): Promise<InviteLinkState> {
    const row = await this.db.query.workspace.findFirst({
      where: and(eq(workspace.id, workspaceId), liveWorkspaces()),
      columns: { inviteLinkCode: true, inviteLinkEnabled: true },
    });
    if (!row) throw new NotFoundException('Workspace not found');
    return this.state(row);
  }

  /**
   * Turning the link on creates the code the first time; turning it off keeps
   * the code, so switching back on restores the same URL. Reset is the only
   * way to change a code.
   */
  async setEnabled(
    workspaceId: string,
    enabled: boolean,
  ): Promise<InviteLinkState> {
    return this.writeWithFreshCode(workspaceId, (name) => ({
      inviteLinkEnabled: enabled,
      // Atomic: two concurrent enables keep whichever code landed first.
      ...(enabled
        ? {
            inviteLinkCode: sql`COALESCE(${workspace.inviteLinkCode}, ${generateInviteCode(name)}::varchar)`,
          }
        : {}),
    }));
  }

  /** A new code; the old one stops working at once. `enabled` is untouched. */
  async reset(workspaceId: string): Promise<InviteLinkState> {
    return this.writeWithFreshCode(workspaceId, (name) => ({
      inviteLinkCode: generateInviteCode(name),
    }));
  }

  /** What the join page shows. Disabled, reset or unknown: the same 404. */
  async preview(code: string): Promise<{
    workspaceName: string;
    workspaceLogo: string | null;
    ownerName: string;
  }> {
    const ws = await this.db.query.workspace.findFirst({
      where: this.openLinkFilter(code),
      columns: { name: true, logo: true },
      with: { owner: { columns: { name: true } } },
    });
    if (!ws) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return {
      workspaceName: ws.name,
      workspaceLogo: ws.logo,
      ownerName: ws.owner?.name?.trim() || 'The workspace owner',
    };
  }

  /**
   * Joins the caller to the workspace behind an enabled link as a MEMBER,
   * under the same seat lock and seat check as an invitation, so the link can
   * never push a workspace past its limit. The owner is the inviter.
   */
  async join(code: string, userId: string): Promise<{ workspaceId: string }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, name: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const email = normalizeEmail(user.email);

    const joined = await this.db.transaction(async (tx) => {
      const found = await tx.query.workspace.findFirst({
        where: this.openLinkFilter(code),
        columns: { id: true },
      });
      if (!found) throw new NotFoundException(NOT_FOUND_MESSAGE);

      await lockWorkspaceSeats(tx, found.id);

      // Read again under the lock: a disable or reset that committed while
      // this request waited for it must win. FOR SHARE keeps the row from
      // being changed until this transaction ends, so one that arrives
      // mid-join waits for the join instead of racing it.
      const [ws] = await tx
        .select({
          id: workspace.id,
          name: workspace.name,
          ownerId: workspace.ownerId,
          timezone: workspace.timezone,
        })
        .from(workspace)
        .where(this.openLinkFilter(code))
        .for('share');
      if (!ws) throw new NotFoundException(NOT_FOUND_MESSAGE);

      const alreadyMember = () =>
        joinConflict(
          'ALREADY_MEMBER',
          'You are already a member of this workspace',
        );
      if (ws.ownerId === userId) throw alreadyMember();
      const existing = await tx.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.workspaceId, ws.id),
          eq(workspaceInvitation.status, 'ACCEPTED'),
          sql`(${workspaceInvitation.userId} = ${userId} OR lower(trim(${workspaceInvitation.email})) = ${email})`,
        ),
        columns: { id: true },
      });
      if (existing) throw alreadyMember();

      // This person's own pending invitation is not a second seat.
      const free = await this.membersService.freeSeats(ws.id, email, tx);
      if (free < 1) {
        throw joinConflict(
          'SEAT_LIMIT_EXCEEDED',
          'SEAT_LIMIT_EXCEEDED: 0 seat(s) left, 1 requested',
        );
      }

      // Joined through the link, so the invitation they never answered is
      // moot (as in restoreMember). Left behind it would hold a seat and its
      // email link would 409.
      await tx
        .delete(workspaceInvitation)
        .where(
          and(
            eq(workspaceInvitation.workspaceId, ws.id),
            eq(workspaceInvitation.status, 'PENDING'),
            sql`lower(trim(${workspaceInvitation.email})) = ${email}`,
          ),
        );

      const now = new Date();
      const [member] = await tx
        .insert(workspaceInvitation)
        .values({
          workspaceId: ws.id,
          email: user.email,
          userId,
          role: 'MEMBER',
          status: 'ACCEPTED',
          invitedBy: ws.ownerId,
          token: crypto.randomBytes(32).toString('hex'),
          expiresAt: now,
          acceptedAt: now,
        })
        .returning();

      // Counted before the lock is released, so the next seat check sees it.
      try {
        await this.usageService.incrementMemberCount(ws.id, userId, userId);
      } catch (error) {
        // Log but don't fail if usage tracking fails (as accept does)
        this.logger.error(
          `Failed to track member usage for ${userId} joining ${ws.id}: ${(error as Error)?.message ?? String(error)}`,
        );
      }
      return { ws, member };
    });

    await this.membersService.notifyInviterOfAcceptance(
      {
        id: joined.member.id,
        workspaceId: joined.ws.id,
        invitedBy: joined.ws.ownerId,
        workspace: { name: joined.ws.name, timezone: joined.ws.timezone },
      },
      user,
      joined.member,
    );

    return { workspaceId: joined.ws.id };
  }

  /** The workspace whose link is on, with this code, and that is not suspended. */
  private openLinkFilter(code: string) {
    return and(
      eq(workspace.inviteLinkCode, code),
      eq(workspace.inviteLinkEnabled, true),
      eq(workspace.isActive, true),
      // The join routes carry a code, not a :workspaceId, so the global
      // guard that 404s a soft-deleted workspace never sees them: a link of
      // a deleted workspace must stop here.
      liveWorkspaces(),
    );
  }

  private state(row: {
    inviteLinkCode: string | null;
    inviteLinkEnabled: boolean;
  }): InviteLinkState {
    const live = row.inviteLinkEnabled && !!row.inviteLinkCode;
    return {
      enabled: row.inviteLinkEnabled,
      url: live ? this.links.frontend(`/join/${row.inviteLinkCode}`) : null,
    };
  }

  /**
   * Updates the workspace with a freshly generated code in the set clause.
   * A code that collides with another workspace's (23505 on the unique index,
   * 2^-50 odds) is retried once with a new one.
   */
  private async writeWithFreshCode(
    workspaceId: string,
    values: (workspaceName: string) => Record<string, unknown>,
  ): Promise<InviteLinkState> {
    const current = await this.db.query.workspace.findFirst({
      where: and(eq(workspace.id, workspaceId), liveWorkspaces()),
      columns: { name: true },
    });
    if (!current) throw new NotFoundException('Workspace not found');

    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.db
          .update(workspace)
          .set({ ...values(current.name), updatedAt: new Date() })
          .where(and(eq(workspace.id, workspaceId), liveWorkspaces()))
          .returning({
            inviteLinkCode: workspace.inviteLinkCode,
            inviteLinkEnabled: workspace.inviteLinkEnabled,
          });
        if (!row) throw new NotFoundException('Workspace not found');
        return this.state(row);
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }
}
