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
import { campaigns } from '../../../drizzle/schema/campaigns.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import {
  posts,
  postHistory,
  type MediaItem,
} from '../../../drizzle/schema/posts.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { AppLinks } from '../../../email/links/app-links';
import { formatWhen } from '../../../email/links/format-when';
import { networkName } from '../../../email/render/components/post-card';
import { APPROVAL_NEEDED } from '../../../email/templates/publishing/approval-needed';
import {
  NOT_SCHEDULED,
  POST_APPROVED,
} from '../../../email/templates/publishing/post-approved';
import { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import { NotifyService } from '../../../notifications/notify.service';
import { RecipientsService } from '../../../notifications/recipients.service';
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
import { ApprovalPolicyService } from './approval-policy.service';

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
  | 'scheduledAt'
> & {
  /** updated_at in microseconds, exact: a JS Date would drop the micros. */
  versionMicros: string;
};

/** Exact edit stamp; compared as a number, never through a JS Date. */
const versionMicrosSql = sql<string>`(extract(epoch from ${posts.updatedAt}) * 1000000)::bigint::text`;

/** The picture an email can show: an image, or a video's thumbnail. */
function thumbnailOf(media: MediaItem[]): string | null {
  const first = media[0];
  if (!first) return null;
  const url = first.thumbnailUrl || (first.type === 'image' ? first.url : '');
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * An ISO time as the milliseconds a job key carries. Null when unreadable: a
 * made-up stamp would give a retry a different key, so the send is skipped.
 */
function stampOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The post as an approval email shows it (the post's first channel). */
interface PostCardFacts {
  platform: string;
  platformName: string;
  handle: string;
  /** The scheduled time in the workspace's zone, or `Not scheduled yet`. */
  when: string;
  caption: string;
  thumbnailUrl: string | null;
  campaignName: string | null;
}

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
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly links: AppLinks,
    // Not @Optional: the module must provide it. Optional in the type only so
    // a unit test that never touches the policy can leave it out.
    private readonly approvalPolicy?: ApprovalPolicyService,
  ) {}

  /** A draft not saved to the server yet reads as "not required". */
  async get(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
  ): Promise<DraftApprovalView> {
    const row = await this.findRow(workspaceId, postId);
    return this.view(workspaceId, row, userId, role);
  }

  /**
   * Switch the requirement on (any member who may draft) or off (approvers
   * only: otherwise the person waiting for approval could simply turn it off
   * and schedule). Turning it on again after it was on is a no-op, except for
   * a request the workspace approval policy wrote, which tells the approvers
   * the first time. A policy request cannot be switched off while the policy
   * still covers its author.
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
      // A request the policy wrote silently on the first save: sending it
      // for approval tells the approvers, once.
      if (current?.byPolicy && !current.notifiedAt) {
        const stamped = await this.stampNotified(workspaceId, postId, userId);
        if (stamped) {
          // Not awaited, like below. The author is the requester.
          void this.notifyApprovers(
            workspaceId,
            row,
            current.requestedById,
            current.requestedAt,
          );
        }
        return this.view(
          workspaceId,
          await this.findRow(workspaceId, postId),
          userId,
          role,
        );
      }
      if (current) return this.view(workspaceId, row, userId, role);
      const request = newApprovalRequest(userId);
      const changed = await this.writeApproval(
        workspaceId,
        postId,
        request,
        'approval_requested',
        userId,
      );
      if (changed) {
        // Not awaited: a slow queue must never delay the request. The method
        // catches and logs its own failures.
        void this.notifyApprovers(
          workspaceId,
          row,
          userId,
          request.requestedAt,
        );
      }
    } else {
      if (!current) return this.view(workspaceId, row, userId, role);
      assertRoleCan(role, APPROVE_CAPABILITY);
      if (await this.policyHolds(workspaceId, current)) {
        throw new ForbiddenException(
          "The workspace approval policy covers this post's author, so its approval can't be switched off.",
        );
      }
      await this.writeApproval(
        workspaceId,
        postId,
        null,
        'approval_cleared',
        userId,
      );
    }
    return this.view(
      workspaceId,
      await this.findRow(workspaceId, postId),
      userId,
      role,
    );
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
      return this.view(workspaceId, row, userId, role);
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
    // Not awaited, like notifyApprovers.
    void this.notifyRequester(
      workspaceId,
      row,
      userId,
      current.requestedById,
      granted.approvedAt ?? '',
    );
    return this.view(
      workspaceId,
      await this.findRow(workspaceId, postId),
      userId,
      role,
    );
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
        scheduledAt: posts.scheduledAt,
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

  /**
   * A request the approval policy wrote stays on while the policy still
   * covers its author: an approver could otherwise switch it off and the
   * author schedule straight away.
   */
  private async policyHolds(
    workspaceId: string,
    approval: DraftApproval | null,
  ): Promise<boolean> {
    if (!approval?.byPolicy) return false;
    return (
      (await this.approvalPolicy?.coversAuthor(
        workspaceId,
        approval.requestedById,
      )) ?? false
    );
  }

  /**
   * Stamps `notifiedAt` on a policy request that has none, and records the
   * request in history. Conditional, so two clicks tell the approvers once.
   * Like writeApproval, never touches `updated_at`.
   */
  private async stampNotified(
    workspaceId: string,
    postId: string,
    userId: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(posts)
        .set({
          metadata: sql`jsonb_set(${posts.metadata}, '{approval,notifiedAt}', to_jsonb(${now}::text))`,
        })
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'draft'),
            sql`${posts.metadata} -> 'approval' ->> 'byPolicy' = 'true'`,
            sql`NOT (${posts.metadata} -> 'approval' ? 'notifiedAt')`,
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) {
        await tx.insert(postHistory).values({
          postId,
          action: 'approval_requested',
          previousStatus: 'draft',
          newStatus: 'draft',
          performedById: userId,
        });
      }
      return rows.length > 0;
    });
  }

  private async view(
    workspaceId: string,
    row: ApprovalRow | null,
    userId: string,
    role: CallerRole,
  ): Promise<DraftApprovalView> {
    const approval = row ? readApproval(row.metadata) : null;
    const canTurnOff =
      may(role, APPROVE_CAPABILITY) &&
      !(await this.policyHolds(workspaceId, approval));
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

  /**
   * The post as the emails show it: first channel's network and handle, the
   * time in the workspace's zone, the caption, a picture and the campaign.
   * Every lookup that can miss falls back to something readable.
   */
  private async postCard(
    workspaceId: string,
    row: ApprovalRow,
    timezone: string,
  ): Promise<PostCardFacts> {
    const target = (row.targets ?? [])[0];
    const platform = target?.platform ?? '';
    const platformName = platform ? networkName(platform) : 'your channel';
    const [handle, campaignName] = await Promise.all([
      this.handleOf(workspaceId, target?.channelId, platformName),
      this.campaignNameOf(workspaceId, row.metadata?.campaignId),
    ]);
    return {
      platform,
      platformName,
      handle,
      when: row.scheduledAt
        ? formatWhen(row.scheduledAt, timezone)
        : NOT_SCHEDULED,
      caption: row.content ?? '',
      thumbnailUrl: thumbnailOf(row.mediaItems ?? []),
      campaignName,
    };
  }

  /** '@username' when the channel has one, else its account name. */
  private async handleOf(
    workspaceId: string,
    channelId: string | number | undefined,
    fallback: string,
  ): Promise<string> {
    const id = parseInt(String(channelId), 10);
    if (!Number.isFinite(id)) return fallback;
    const [channel] = await this.db
      .select({
        username: socialMediaChannels.username,
        accountName: socialMediaChannels.accountName,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, id),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      );
    if (!channel) return fallback;
    return channel.username
      ? `@${channel.username.replace(/^@/, '')}`
      : channel.accountName;
  }

  /** The campaign's name, or null when the post has none or it is gone. */
  private async campaignNameOf(
    workspaceId: string,
    campaignId: unknown,
  ): Promise<string | null> {
    if (typeof campaignId !== 'string' || !UUID_RE.test(campaignId)) {
      return null;
    }
    const [campaign] = await this.db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.workspaceId, workspaceId),
        ),
      );
    return campaign?.name ?? null;
  }

  /**
   * C3 and the bell, to everyone who can approve except the requester. Best
   * effort: a notification failure never undoes the request. Whether each
   * person is still a member is checked again when the email is sent.
   */
  private async notifyApprovers(
    workspaceId: string,
    row: ApprovalRow,
    actorId: string,
    requestedAt: string,
  ): Promise<void> {
    try {
      const stamp = stampOf(requestedAt);
      const approvers = (await this.recipients.admins(workspaceId)).filter(
        (r) => ALLOW_SELF_APPROVAL || r.id !== actorId,
      );
      if (approvers.length === 0) return;
      const ws = await this.recipients.workspace(workspaceId);
      if (!ws) return;
      if (stamp === null) {
        this.logger.warn(
          `approval request time of post ${row.id} is unreadable: emails skipped`,
        );
      }
      const [requester, card] = await Promise.all([
        this.recipients.user(actorId),
        this.postCard(workspaceId, row, ws.timezone),
      ]);
      const requesterName = requester
        ? this.recipients.displayName(requester)
        : 'A teammate';
      const preview = readyPreview(row.content);
      // One key per request: sending it for approval again after an edit is a
      // new request (new timestamp), a queue retry of the same one is not.
      await Promise.all(
        approvers.map((approver) =>
          this.notify.notify({
            userId: approver.id,
            workspaceId,
            event: 'approval_request',
            bell: () =>
              this.notifications.approvalRequested(approver.id, {
                workspaceId,
                postId: row.id,
                requestedByName: requesterName,
                preview,
              }),
            email:
              stamp === null
                ? undefined
                : {
                    template: APPROVAL_NEEDED,
                    to: approver.email,
                    props: {
                      requesterName,
                      platform: card.platform,
                      platformName: card.platformName,
                      handle: card.handle,
                      when: card.when,
                      caption: card.caption,
                      thumbnailUrl: card.thumbnailUrl,
                      campaignName: card.campaignName,
                      goesOut: card.when,
                      reviewUrl: this.links.planner(workspaceId, row.id),
                      workspaceName: ws.name,
                    },
                    idempotencyKey: `approval-requested.${row.id}.${stamp}.${approver.id}`,
                  },
          }),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `approval fan-out for post ${row.id} failed: ${(err as Error).message}`,
      );
    }
  }

  /** C4 and the bell, to whoever asked for the approval. Never throws. */
  private async notifyRequester(
    workspaceId: string,
    row: ApprovalRow,
    approverId: string,
    requesterId: string,
    approvedAt: string,
  ): Promise<void> {
    if (requesterId === approverId) return;
    try {
      const stamp = stampOf(approvedAt);
      const ws = await this.recipients.workspace(workspaceId);
      if (!ws) return;
      if (stamp === null) {
        this.logger.warn(
          `approval time of post ${row.id} is unreadable: email skipped`,
        );
      }
      const [approver, card] = await Promise.all([
        this.recipients.user(approverId),
        this.postCard(workspaceId, row, ws.timezone),
      ]);
      const approverName = approver
        ? this.recipients.displayName(approver)
        : 'A teammate';
      await this.notify.notify({
        userId: requesterId,
        workspaceId,
        event: 'post_approved',
        bell: () =>
          this.notifications.draftApproved(requesterId, {
            workspaceId,
            postId: row.id,
            approvedByName: approverName,
            preview: readyPreview(row.content),
          }),
        email:
          stamp === null
            ? undefined
            : {
                template: POST_APPROVED,
                props: {
                  approverName,
                  platform: card.platform,
                  platformName: card.platformName,
                  handle: card.handle,
                  when: card.when,
                  caption: card.caption,
                  thumbnailUrl: card.thumbnailUrl,
                  goesOutSentence: row.scheduledAt
                    ? `It goes out on ${card.platformName} ${card.when}. Nothing else to do.`
                    : "It's ready to schedule.",
                  plannerUrl: this.links.planner(workspaceId, row.id),
                },
                idempotencyKey: `post-approved.${row.id}.${stamp}`,
              },
      });
    } catch (err) {
      this.logger.warn(
        `draft_approved notification for post ${row.id} failed: ${(err as Error).message}`,
      );
    }
  }
}
