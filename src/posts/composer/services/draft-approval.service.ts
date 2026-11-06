import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts, postHistory } from '../../../drizzle/schema/posts.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { workspace } from '../../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../../drizzle/schema/workspace-invitation.schema';
import { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import { assertRoleCan } from '../../../workspace-members/workspace-role.guard';
import { roleCan } from '../../../workspace-members/role-capabilities';
import type { CallerRole } from '../../guest-rules';
import {
  ALLOW_SELF_APPROVAL,
  APPROVE_CAPABILITY,
  approvalState,
  contentFingerprint,
  newApprovalRequest,
  readApproval,
  type ApprovalState,
  type DraftApproval,
} from '../../lib/draft-approval';
import { readyPreview } from '../../services/post-drafts.service';

export interface ApprovalPerson {
  id: string;
  name: string;
}

/** GET/PUT/POST answer for one draft's approval. */
export interface DraftApprovalView {
  required: boolean;
  state: ApprovalState;
  requestedBy: ApprovalPerson | null;
  requestedAt: string | null;
  approvedBy: ApprovalPerson | null;
  approvedAt: string | null;
  /** The caller may approve it now. */
  canApprove: boolean;
  /** The caller may switch the requirement off. */
  canTurnOff: boolean;
}

type ApprovalRow = Pick<
  typeof posts.$inferSelect,
  | 'id'
  | 'status'
  | 'content'
  | 'mediaItems'
  | 'platformContent'
  | 'targets'
  | 'metadata'
> & {
  /** updated_at in microseconds, exact: a JS Date would drop the micros. */
  versionMicros: string;
};

/** Exact edit stamp; compared as a number, never through a JS Date. */
const versionMicrosSql = sql<string>`(extract(epoch from ${posts.updatedAt}) * 1000000)::bigint::text`;

const may = (role: CallerRole, cap: typeof APPROVE_CAPABILITY): boolean =>
  role === 'SUPER_ADMIN' || (role !== undefined && roleCan(role, cap));

/**
 * "Needs approval" on a draft. The request and the grant live in
 * `posts.metadata.approval`; the guard that refuses to schedule or publish
 * without a matching grant is `assertApprovedFor` (lib/draft-approval.ts),
 * called by every path that sends a post out.
 */
@Injectable()
export class DraftApprovalService {
  private readonly logger = new Logger(DraftApprovalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly notifications: NotificationEmitterService,
  ) {}

  /** A draft not saved to the server yet reads as "not required". */
  async get(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
  ): Promise<DraftApprovalView> {
    const row = await this.findRow(workspaceId, postId);
    return this.view(row, userId, role);
  }

  /**
   * Switch the requirement on (any member who may draft) or off (approvers
   * only: otherwise the person waiting for approval could simply turn it off
   * and schedule). Turning it on again after it was on is a no-op.
   */
  async setRequired(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
    required: boolean,
  ): Promise<DraftApprovalView> {
    const row = await this.findRow(workspaceId, postId);
    if (!row) {
      throw new NotFoundException('Save the draft before asking for approval');
    }
    if (row.status !== 'draft') {
      throw new BadRequestException('Only drafts can ask for approval');
    }
    const current = readApproval(row.metadata);

    if (required) {
      if (current) return this.view(row, userId, role);
      const request = newApprovalRequest(userId);
      const changed = await this.writeApproval(
        workspaceId,
        postId,
        request,
        'approval_requested',
        userId,
      );
      if (changed) {
        await this.notifyApprovers(workspaceId, postId, userId, row.content);
      }
    } else {
      if (!current) return this.view(row, userId, role);
      assertRoleCan(role, APPROVE_CAPABILITY);
      await this.writeApproval(
        workspaceId,
        postId,
        null,
        'approval_cleared',
        userId,
      );
    }
    return this.view(await this.findRow(workspaceId, postId), userId, role);
  }

  /**
   * Grant the approval for the draft exactly as it is stored now. The write
   * is conditional on `updated_at`, so a save that lands between reading the
   * draft and approving it is not approved by accident.
   */
  async approve(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
  ): Promise<DraftApprovalView> {
    assertRoleCan(role, APPROVE_CAPABILITY);
    const row = await this.findRow(workspaceId, postId);
    if (!row) throw new NotFoundException('Post not found');
    if (row.status !== 'draft') {
      throw new BadRequestException('Only drafts can be approved');
    }
    const current = readApproval(row.metadata);
    if (!current) {
      throw new BadRequestException('This draft is not waiting for approval');
    }
    const fingerprint = contentFingerprint(row);
    if (approvalState(current, fingerprint) === 'approved') {
      return this.view(row, userId, role);
    }
    if (!ALLOW_SELF_APPROVAL && current.requestedById === userId) {
      throw new ForbiddenException(
        'You asked for this approval, so someone else has to give it',
      );
    }

    const granted: DraftApproval = {
      ...current,
      approvedById: userId,
      approvedAt: new Date().toISOString(),
      approvedFingerprint: fingerprint,
    };
    const changed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(posts)
        .set({
          metadata: sql`coalesce(${posts.metadata}, '{}'::jsonb) || jsonb_build_object('approval', ${JSON.stringify(granted)}::jsonb)`,
        })
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'draft'),
            sql`(extract(epoch from ${posts.updatedAt}) * 1000000)::bigint = ${row.versionMicros}::bigint`,
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) {
        await tx.insert(postHistory).values({
          postId,
          action: 'approved',
          previousStatus: 'draft',
          newStatus: 'draft',
          performedById: userId,
        });
      }
      return rows.length > 0;
    });
    if (!changed) {
      throw new ConflictException(
        'The draft changed while you were approving it. Open it again to see the latest version.',
      );
    }
    await this.notifyRequester(
      workspaceId,
      postId,
      userId,
      current.requestedById,
      row.content,
    );
    return this.view(await this.findRow(workspaceId, postId), userId, role);
  }

  // ---------------------------------------------------------------------------

  private async findRow(
    workspaceId: string,
    postId: string,
  ): Promise<ApprovalRow | null> {
    const [row] = await this.db
      .select({
        id: posts.id,
        status: posts.status,
        content: posts.content,
        mediaItems: posts.mediaItems,
        platformContent: posts.platformContent,
        targets: posts.targets,
        metadata: posts.metadata,
        versionMicros: versionMicrosSql,
      })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    return row ?? null;
  }

  /**
   * Sets (or removes, for null) `metadata.approval` and records history in
   * one transaction. Never touches `updated_at`: asking for approval is not
   * an edit, and `approve` uses `updated_at` to spot real edits.
   */
  private async writeApproval(
    workspaceId: string,
    postId: string,
    approval: DraftApproval | null,
    action: 'approval_requested' | 'approval_cleared',
    userId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(posts)
        .set({
          metadata: approval
            ? sql`coalesce(${posts.metadata}, '{}'::jsonb) || jsonb_build_object('approval', ${JSON.stringify(approval)}::jsonb)`
            : sql`coalesce(${posts.metadata}, '{}'::jsonb) - 'approval'`,
        })
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'draft'),
            approval
              ? sql`NOT (coalesce(${posts.metadata}, '{}'::jsonb) ? 'approval')`
              : sql`coalesce(${posts.metadata}, '{}'::jsonb) ? 'approval'`,
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) {
        await tx.insert(postHistory).values({
          postId,
          action,
          previousStatus: 'draft',
          newStatus: 'draft',
          performedById: userId,
        });
      }
      return rows.length > 0;
    });
  }

  private async view(
    row: ApprovalRow | null,
    userId: string,
    role: CallerRole,
  ): Promise<DraftApprovalView> {
    const approval = row ? readApproval(row.metadata) : null;
    const canTurnOff = may(role, APPROVE_CAPABILITY);
    if (!row || !approval) {
      return {
        required: false,
        state: 'none',
        requestedBy: null,
        requestedAt: null,
        approvedBy: null,
        approvedAt: null,
        canApprove: false,
        canTurnOff,
      };
    }
    const state = approvalState(approval, contentFingerprint(row));
    const people = await this.people([
      approval.requestedById,
      ...(state === 'approved' && approval.approvedById
        ? [approval.approvedById]
        : []),
    ]);
    return {
      required: true,
      state,
      requestedBy: people.get(approval.requestedById) ?? null,
      requestedAt: approval.requestedAt || null,
      approvedBy:
        state === 'approved' && approval.approvedById
          ? (people.get(approval.approvedById) ?? null)
          : null,
      approvedAt: state === 'approved' ? approval.approvedAt : null,
      canApprove:
        state === 'pending' &&
        row.status === 'draft' &&
        may(role, APPROVE_CAPABILITY) &&
        (ALLOW_SELF_APPROVAL || approval.requestedById !== userId),
      canTurnOff,
    };
  }

  private async people(ids: string[]): Promise<Map<string, ApprovalPerson>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(
      rows.map((r) => [r.id, { id: r.id, name: r.name || r.email }]),
    );
  }

  /** Owner plus accepted ADMIN invitees: everyone `posts:approve` reaches. */
  private async approverIds(workspaceId: string): Promise<string[]> {
    const [owner] = await this.db
      .select({ id: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    const admins = await this.db
      .select({ id: workspaceInvitation.userId })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
          eq(workspaceInvitation.role, 'ADMIN'),
        ),
      );
    const ids = new Set<string>();
    if (owner?.id) ids.add(owner.id);
    for (const r of admins) if (r.id) ids.add(r.id);
    return [...ids];
  }

  private async nameOf(userId: string): Promise<string> {
    const [actor] = await this.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return actor?.name || actor?.email || 'A teammate';
  }

  /** Best effort: a notification failure never undoes the request. */
  private async notifyApprovers(
    workspaceId: string,
    postId: string,
    actorId: string,
    content: string | null,
  ): Promise<void> {
    try {
      const recipients = (await this.approverIds(workspaceId)).filter(
        (id) => ALLOW_SELF_APPROVAL || id !== actorId,
      );
      if (recipients.length === 0) return;
      const requestedByName = await this.nameOf(actorId);
      const preview = readyPreview(content);
      await Promise.all(
        recipients.map((id) =>
          this.notifications
            .approvalRequested(id, {
              workspaceId,
              postId,
              requestedByName,
              preview,
            })
            .catch((err: Error) =>
              this.logger.warn(
                `approval_requested notification to ${id} failed: ${err.message}`,
              ),
            ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `approval fan-out for post ${postId} failed: ${(err as Error).message}`,
      );
    }
  }

  private async notifyRequester(
    workspaceId: string,
    postId: string,
    approverId: string,
    requesterId: string,
    content: string | null,
  ): Promise<void> {
    if (requesterId === approverId) return;
    try {
      await this.notifications.draftApproved(requesterId, {
        workspaceId,
        postId,
        approvedByName: await this.nameOf(approverId),
        preview: readyPreview(content),
      });
    } catch (err) {
      this.logger.warn(
        `draft_approved notification for post ${postId} failed: ${(err as Error).message}`,
      );
    }
  }
}
