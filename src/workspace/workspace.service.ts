import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import {
  plans,
  posts,
  socialMediaChannels,
  subscriptions,
  workspace,
  workspaceInvitation,
  workspaceUsage,
  Workspace,
  type ApprovalPolicy,
} from 'src/drizzle/schema';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { UsageService } from 'src/billing/services/usage.service';
import { UsersService } from 'src/users/users.service';
import {
  SubscriptionService,
  isCancellable,
} from 'src/billing/services/subscription.service';
import { SubscriptionLookupService } from 'src/billing/services/subscription-lookup.service';
import { AddonService } from 'src/billing/services/addon.service';
import { resolveWorkspaceLimits } from 'src/billing/services/limit-resolver.util';
import { getNextTokenResetDate } from 'src/billing/services/token-reset.util';
import { LibrarySamplesService } from 'src/media-library/samples/library-samples.service';
import { rescheduleWorkspaceReports } from '../insights/reports/lib/reschedule';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import {
  WorkspaceTimezoneMoveService,
  type TimezoneMoveResult,
} from './workspace-timezone-move.service';
import { QUEUES } from '../queue/queue.module';

export type { TimezoneMoveResult };

type GetAllREsponse = {
  // Omits the Maestro BYOK credential — it must never reach a client.
  data: Omit<Workspace, 'maestroAnthropicKey'>[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

/**
 * What GET /workspace/:workspaceId answers: the row without the two secrets
 * (the encrypted Maestro key and the join-link code), plus the owner and a
 * display name for them. Any ADMIN reads this, so nothing here may be a
 * credential.
 */
export type WorkspaceDetail = Omit<
  Workspace,
  'maestroAnthropicKey' | 'inviteLinkCode'
> & {
  owner: { id: string; name: string | null; email: string };
  ownerName: string;
};

/** The three composer defaults an Editor reads before writing a post. */
export interface PublishingDefaults {
  approvalPolicy: ApprovalPolicy;
  shortenLinksDefault: boolean;
  utmDefault: boolean;
}

/** What deleting a workspace takes with it, shown before the typed confirm. */
export interface DeletionPreview {
  /** Channels not disconnected. */
  channels: number;
  scheduledPosts: number;
  /** ACCEPTED members other than guests (the owner is not a member row). */
  members: number;
  guests: number;
  /** The owner owns no other workspace. */
  isLastOwnedWorkspace: boolean;
  /**
   * The delete would cancel the owner's plan at the period end: it is their
   * last workspace and isCancellable says so (the rule remove() acts on).
   * The dialog's "plan is cancelled" line reads this, never planName.
   */
  cancelsPlan: boolean;
  /** The owner's plan (as on "Your workspaces"), for display only. */
  planName: string;
}

/** Subscription states that mean the owner is on their plan (Task 10). */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

/** A 400 with a machine-readable `code` the frontend reads. */
function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private usersService: UsersService,
    @Inject(forwardRef(() => SubscriptionService))
    private subscriptionService: SubscriptionService,
    private lookup: SubscriptionLookupService,
    @Inject(forwardRef(() => AddonService))
    private addonService: AddonService,
    private librarySamples: LibrarySamplesService,
    // Last three: positional specs construct this service directly.
    private r2: CloudflareR2Service,
    private timezoneMove: WorkspaceTimezoneMoveService,
    // Deleting a workspace cancels its scheduled posts' publish jobs.
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private publishingQueue: Queue,
  ) {}

  async create(
    createWorkspaceDto: CreateWorkspaceDto,
    userId: string,
  ): Promise<Workspace> {
    // Check workspace limit before creating
    try {
      await this.usageService.enforceWorkspaceLimit(userId);
    } catch (error) {
      // Only throw if it's a ForbiddenException (limit reached)
      // Other errors (like no subscription) should allow first workspace creation
      if (error.status === 403) {
        throw error;
      }
    }

    const slug = this.generateSlug(createWorkspaceDto.name);

    const existingWorkspace = await this.db.query.workspace.findFirst({
      where: eq(workspace.slug, slug),
    });

    if (existingWorkspace) {
      throw new ConflictException(
        `Workspace with name "${createWorkspaceDto.name}" already exists. Please choose a different name.`,
      );
    }

    const [newWorkspace] = await this.db
      .insert(workspace)
      .values({
        name: createWorkspaceDto.name,
        slug: slug,
        description: createWorkspaceDto.description || null,
        logo: createWorkspaceDto.logo || null,
        timezone: createWorkspaceDto.timezone || 'UTC',
        ownerId: userId,
      })
      .returning();

    // Auto-create FREE subscription for the new workspace
    try {
      this.logger.log(
        `Creating FREE subscription for new workspace ${newWorkspace.id}`,
      );
      await this.subscriptionService.createSubscription({
        workspaceId: newWorkspace.id,
        userId: userId,
        planCode: 'FREE',
      });
      this.logger.log(
        `FREE subscription created for workspace ${newWorkspace.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to create subscription for workspace ${newWorkspace.id}: ${error.message}`,
      );
      // Don't fail workspace creation if subscription fails - can be created later
    }

    // Seed this workspace's limits from the owner's subscription.
    //
    // Why this has to exist: `applyLimitsToAllWorkspaces` fans plan changes out
    // with UPDATE, so a workspace with no `workspace_usage` row is silently
    // skipped by every future plan change, add-on purchase and downgrade — and
    // `getWorkspaceUsage` throws for it. Only the account's FIRST workspace
    // ever got a row (via createFreeSubscription); the second onward had none.
    await this.seedWorkspaceUsage(newWorkspace.id, userId);

    // Auto-set lastAccessedWorkspaceId if this is user's first workspace
    const user = await this.usersService.findOne(userId);
    if (!user.lastAccessedWorkspaceId) {
      await this.usersService.setLastAccessedWorkspace(userId, newWorkspace.id);
    }

    // Sample Library content ("Getting started"), seeded off the request path
    // after the workspace row is committed. It must never fail or slow the
    // creation: seedInBackground does not block and does not throw, and the
    // guard covers even a synchronous surprise.
    try {
      this.librarySamples.seedInBackground(newWorkspace.id);
    } catch (error) {
      this.logger.error(
        `Could not schedule Library samples for workspace ${newWorkspace.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return newWorkspace;
  }

  /**
   * Create the `workspace_usage` row a new workspace needs, sized from the
   * owner's account-wide subscription.
   *
   * `onConflictDoNothing` because the account's first workspace already got a
   * row from `createFreeSubscription` moments earlier; `workspace_usage.
   * workspace_id` is UNIQUE, so a plain insert would fail there and take
   * workspace creation down with it. Whoever wrote the row first wins.
   */
  private async seedWorkspaceUsage(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    try {
      const subscription = await this.lookup.findByUserId(userId);
      const planCode =
        subscription && subscription.status === 'active'
          ? subscription.planCode
          : 'FREE';
      const addons = subscription
        ? await this.lookup.getAddonQuantities(subscription.id)
        : {
            extraChannels: 0,
            extraMembers: 0,
            extraWorkspaces: 0,
            extraAiTokens: 0,
          };
      const plan = await this.lookup.getPlanLimits(planCode);

      // A newly created workspace starts EMPTY (no channels, no seats) unless
      // it is the account's first. Purchased channels and seats live on the
      // primary workspace only — otherwise buying an EXTRA_WORKSPACE would be
      // a cheaper way to buy channels than buying channels.
      //
      // Counted AFTER the insert, so the account's very first workspace sees
      // exactly 1 and is the only one treated as primary.
      const [ownedCount] = await this.db
        .select({ n: count() })
        .from(workspace)
        .where(eq(workspace.ownerId, userId));
      const isFirst = Number(ownedCount?.n ?? 0) === 1;

      const limits = resolveWorkspaceLimits(plan, addons, isFirst);

      await this.db
        .insert(workspaceUsage)
        .values({
          workspaceId,
          channelsLimit: limits.channelsLimit,
          membersLimit: limits.membersLimit,
          aiTokensLimit: limits.aiTokensLimit,
          storageBytesLimit: limits.storageBytesLimit,
          channelsCount: 0,
          membersCount: 0,
          // The purchased extras belong to the ACCOUNT, and every reader
          // computes the ceiling as `limit + extraPurchased`. The primary
          // workspace must therefore carry them, or an account that bought
          // add-ons before creating this workspace would silently lose them.
          // Non-primary workspaces get zero, matching their zero base.
          extraChannelsPurchased: isFirst ? addons.extraChannels : 0,
          extraMembersPurchased: isFirst ? addons.extraMembers : 0,
          extraAiTokensPurchased: isFirst ? addons.extraAiTokens : 0,
          // Required, not optional. The monthly reset is gated on this being
          // non-null, so a row seeded without it never rolls over: the
          // workspace burns its first month's allowance and stays at zero
          // forever, with no code path able to revive it.
          aiTokensResetDate: getNextTokenResetDate(),
        })
        .onConflictDoNothing({ target: workspaceUsage.workspaceId });
    } catch (error) {
      // A missing usage row degrades gracefully (limits read as unset) whereas
      // a thrown error here would lose the workspace the user just created.
      this.logger.error(
        `Failed to seed usage for workspace ${workspaceId}: ${error.message}`,
      );
    }
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async findAllPaginated(
    userId: string,
    page: number = 1,
    limit: number = 10,
    search?: string,
    isActive?: boolean,
  ): Promise<GetAllREsponse> {
    const offset = (page - 1) * limit;

    const conditions = [eq(workspace.ownerId, userId)];

    if (typeof isActive === 'boolean') {
      conditions.push(eq(workspace.isActive, isActive));
    }

    const workspaces = await this.db.query.workspace.findMany({
      where: and(...conditions),
      // Never ship the Maestro BYOK credential to a client. See findOne.
      columns: { maestroAnthropicKey: false },
      limit: limit,
      offset: offset,
      orderBy: (workspace, { desc }) => [desc(workspace.createdAt)],
    });

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workspace)
      .where(and(...conditions));

    return {
      data: workspaces,
      pagination: {
        page,
        limit,
        total: Number(count),
        totalPages: Math.ceil(Number(count) / limit),
      },
    };
  }

  async findAllByUser(
    userId: string,
  ): Promise<Omit<Workspace, 'maestroAnthropicKey'>[]> {
    const workspaces = await this.db.query.workspace.findMany({
      where: eq(workspace.ownerId, userId),
      // Never ship the Maestro BYOK credential to a client. See findOne.
      columns: { maestroAnthropicKey: false },
      orderBy: (workspace, { desc }) => [desc(workspace.createdAt)],
    });

    return workspaces;
  }

  async findOne(
    identifier: string,
    userId: string,
    bySlug: boolean = false,
  ): Promise<Omit<Workspace, 'maestroAnthropicKey'>> {
    const condition = bySlug
      ? eq(workspace.slug, identifier)
      : eq(workspace.id, identifier);

    const result = await this.db.query.workspace.findFirst({
      where: and(condition, eq(workspace.ownerId, userId)),
      columns: {
        // Everything EXCEPT the Maestro BYOK credential. This row is returned
        // straight to the client by GET /workspace/:id and /slug/:slug, so the
        // encrypted key must never be part of it. Read it only through
        // MaestroKeyService, which exposes a masked hint instead.
        maestroAnthropicKey: false,
      },
      with: {
        owner: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!result) {
      throw new NotFoundException(
        `Workspace with ${bySlug ? 'slug' : 'id'} "${identifier}" not found or you don't have access`,
      );
    }

    // Check if workspace is suspended
    if (!result.isActive) {
      throw new ForbiddenException(
        `This workspace has been suspended. Reason: ${result.suspendedReason || 'Contact support for details.'}`,
      );
    }

    return result;
  }

  /**
   * The General page's read. No owner filter: WorkspaceRoleGuard has already
   * decided the caller may see this workspace (`settings:view`).
   *
   * Never carries `maestroAnthropicKey` or `inviteLinkCode`: a MEMBER reads
   * this, and neither the encrypted BYOK credential nor the join-link secret
   * is theirs to hold.
   */
  async findDetail(workspaceId: string): Promise<WorkspaceDetail> {
    const result = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { maestroAnthropicKey: false, inviteLinkCode: false },
      with: {
        owner: { columns: { id: true, name: true, email: true } },
      },
    });

    if (!result) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    if (!result.isActive) {
      throw new ForbiddenException(
        `This workspace has been suspended. Reason: ${result.suspendedReason || 'Contact support for details.'}`,
      );
    }

    return { ...result, ownerName: result.owner.name ?? result.owner.email };
  }

  /** The composer's starting switches, readable by anyone who can draft. */
  async getPublishingDefaults(
    workspaceId: string,
  ): Promise<PublishingDefaults> {
    const row = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: {
        approvalPolicy: true,
        shortenLinksDefault: true,
        utmDefault: true,
      },
    });
    if (!row) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }
    return row;
  }

  /**
   * Who may call this is decided by the route (`workspace:manage`), not here:
   * an ADMIN edits General as readily as the owner, so there is no owner check.
   */
  async update(
    workspaceId: string,
    updateWorkspaceDto: UpdateWorkspaceDto,
  ): Promise<{
    workspace: Workspace;
    timezoneMove: TimezoneMoveResult | null;
  }> {
    // Not a column: the time-zone move reads it, the row never stores it.
    const { applyTimezoneToChannels, ...columns } = updateWorkspaceDto;
    if (
      applyTimezoneToChannels !== undefined &&
      columns.timezone === undefined
    ) {
      throw badRequest(
        'TIMEZONE_REQUIRED',
        'applyTimezoneToChannels needs a timezone to apply.',
      );
    }

    // A logo is only ever a file our presign issued; an arbitrary URL would
    // be a tracking pixel on every screen that shows the workspace.
    if (
      typeof columns.logo === 'string' &&
      !this.r2.isOwnPublicUrl(columns.logo, 'workspace-logo', workspaceId)
    ) {
      throw badRequest(
        'LOGO_NOT_UPLOADED',
        'Upload the logo first, then save the URL it returns.',
      );
    }

    const existingWorkspace = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!existingWorkspace) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    // Set only when the new name makes a different slug.
    let slugChange: { slug: string } | undefined;
    if (columns.name) {
      const newSlug = this.generateSlug(columns.name);

      if (newSlug !== existingWorkspace.slug) {
        const slugExists = await this.db.query.workspace.findFirst({
          where: and(
            eq(workspace.slug, newSlug),
            sql`${workspace.id} != ${workspaceId}`,
          ),
        });

        if (slugExists) {
          throw new ConflictException(
            `Workspace with name "${columns.name}" already exists. Please choose a different name.`,
          );
        }

        slugChange = { slug: newSlug };
      }
    }

    const writeRow = async (db: Pick<DbType, 'update'>): Promise<Workspace> => {
      const [row] = await db
        .update(workspace)
        .set({
          ...columns,
          ...slugChange,
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, workspaceId))
        .returning();
      return row;
    };

    // "Also move existing": the row is written inside the move's locked
    // transaction, after its in-progress check, so a 409 saves nothing and
    // the workspace never lands on a zone its channels and posts did not
    // follow. Channels and scheduled posts follow the new zone; a post keeps
    // the local time it had in its channel's old zone. It runs even when the
    // workspace zone is unchanged: it pulls channels still in another zone
    // onto it. A save without the flag takes no lock.
    const moveToZone =
      applyTimezoneToChannels === true ? columns.timezone : undefined;
    // Filled by whichever path writes the row.
    const saved: { row?: Workspace } = {};
    let timezoneMove: TimezoneMoveResult | null = null;
    if (moveToZone === undefined) {
      saved.row = await writeRow(this.db);
    } else {
      timezoneMove = await this.timezoneMove.moveExisting(
        workspaceId,
        existingWorkspace.timezone,
        moveToZone,
        {
          writeFirst: async (tx) => {
            saved.row = await writeRow(tx);
          },
        },
      );
    }
    // Deleted between the read above and the write.
    if (!saved.row) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    // One tail for a rename and a plain save alike.
    if (
      columns.timezone !== undefined &&
      columns.timezone !== existingWorkspace.timezone
    ) {
      await this.rescheduleReports(workspaceId, columns.timezone);
    }

    return { workspace: saved.row, timezoneMove };
  }

  /**
   * Scheduled Insights reports send at a wall-clock time in the workspace's
   * zone, so a new zone moves their next send. A failure here never fails
   * the settings save: the reports then keep their old slots.
   */
  private async rescheduleReports(
    workspaceId: string,
    timeZone: string,
  ): Promise<void> {
    try {
      await rescheduleWorkspaceReports(
        this.db,
        workspaceId,
        timeZone,
        new Date(),
      );
    } catch (error) {
      this.logger.warn(
        `Could not reschedule reports for workspace ${workspaceId} after a time zone change: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Counts for the delete dialog. Behind `workspace:delete`, so only the
   * owner (or a platform super admin) reads them.
   */
  async deletionPreview(workspaceId: string): Promise<DeletionPreview> {
    const existing = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { id: true, ownerId: true },
    });
    if (!existing) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    const [[channels], [scheduled], roles, ownedOthers, planName, [sub]] =
      await Promise.all([
        this.db
          .select({ n: count() })
          .from(socialMediaChannels)
          .where(
            and(
              eq(socialMediaChannels.workspaceId, workspaceId),
              ne(socialMediaChannels.connectionStatus, 'disconnected'),
            ),
          ),
        this.db
          .select({ n: count() })
          .from(posts)
          .where(
            and(
              eq(posts.workspaceId, workspaceId),
              eq(posts.status, 'scheduled'),
            ),
          ),
        this.db
          .select({ role: workspaceInvitation.role, n: count() })
          .from(workspaceInvitation)
          .where(
            and(
              eq(workspaceInvitation.workspaceId, workspaceId),
              eq(workspaceInvitation.status, 'ACCEPTED'),
            ),
          )
          .groupBy(workspaceInvitation.role),
        this.countOwnedWorkspaces(existing.ownerId, workspaceId),
        this.ownerPlanName(existing.ownerId),
        // The same row lookup.findByUserId reads for the cancel itself.
        this.db
          .select({
            planCode: subscriptions.planCode,
            status: subscriptions.status,
            cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          })
          .from(subscriptions)
          .where(eq(subscriptions.userId, existing.ownerId))
          .limit(1),
      ]);

    let members = 0;
    let guests = 0;
    for (const r of roles) {
      if (r.role === 'GUEST') guests += Number(r.n);
      else members += Number(r.n);
    }

    return {
      channels: Number(channels?.n ?? 0),
      scheduledPosts: Number(scheduled?.n ?? 0),
      members,
      guests,
      isLastOwnedWorkspace: ownedOthers === 0,
      // remove() cancels at the period end: the same `true` here.
      cancelsPlan: ownedOthers === 0 && isCancellable(sub, true),
      planName,
    };
  }

  /**
   * Permanently deletes a workspace. `workspace:delete` (OWNER, or a
   * platform super admin through the guard) is the authorisation; the typed
   * name is the confirmation. Everything after the DELETE is best effort and
   * logged: the workspace is already gone, so nothing there may fail it.
   *
   * Billing is the OWNER's account, never the caller's: a super admin who
   * deletes someone's workspace releases the owner's slot.
   */
  async remove(
    workspaceId: string,
    userId: string,
    confirmName: string,
  ): Promise<{ message: string }> {
    const existingWorkspace = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!existingWorkspace) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    // Exact and case-sensitive. Both sides are trimmed: the frontend sends
    // the typed name trimmed, and a legacy row may hold surrounding spaces
    // nobody can see to type.
    if (confirmName.trim() !== existingWorkspace.name.trim()) {
      throw badRequest(
        'CONFIRM_NAME_MISMATCH',
        'Type the workspace name exactly to delete it.',
      );
    }

    const ownerId = existingWorkspace.ownerId;

    // Only the slot release reads this unlocked count: it must run before the
    // DELETE (below) and calls the provider, which no row lock should wait on.
    // The cancel decision uses the locked count inside the delete.
    const ownedAfterEstimate = await this.countOwnedWorkspaces(
      ownerId,
      workspaceId,
    );

    // Give back the workspace slot BEFORE deleting, while this workspace still
    // exists for removeAddon to verify ownership against.
    //
    // Without this the customer keeps paying an EXTRA_WORKSPACE line for a
    // workspace that no longer exists, every month, until they notice. Only
    // reduce when the account is actually over its included allowance —
    // deleting a workspace that the plan already covers should cost nothing.
    try {
      const included = await this.includedWorkspaces(ownerId);

      if (ownedAfterEstimate < included.purchasedFloor) {
        await this.addonService.removeAddon(
          workspaceId,
          ownerId,
          'EXTRA_WORKSPACE',
          1,
        );
      }
    } catch (error) {
      // A billing hiccup must not strand the user with an undeletable
      // workspace; the slot is reconciled by the next plan or add-on change.
      this.logger.error(
        `Failed to release the workspace slot for ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const deleted = await this.deleteLocked(workspaceId, ownerId);
    if (!deleted) {
      // Deleted by a parallel request while this one released the slot.
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }
    const { scheduledPosts, ownedAfter } = deleted;

    await this.cancelPublishJobs(workspaceId, scheduledPosts);
    // A pending "Also move existing" would otherwise re-arm jobs for posts
    // that no longer exist.
    await this.timezoneMove.cancelPendingMove(workspaceId);

    if (ownedAfter === 0) {
      await this.cancelPaidPlan(ownerId, userId, workspaceId);
    }

    // Remaining workspaces re-derive their limits: deleting the primary one
    // promotes the next-oldest, and nothing else recomputes the fan-out.
    // Channels are pooled, so freeing this workspace's channels may also let
    // previously locked channels come back.
    try {
      const subscription = await this.lookup.findByUserId(ownerId);
      const planCode =
        subscription && subscription.status === 'active'
          ? subscription.planCode
          : 'FREE';
      const addons = subscription
        ? await this.lookup.getAddonQuantities(subscription.id)
        : {
            extraChannels: 0,
            extraMembers: 0,
            extraWorkspaces: 0,
            extraAiTokens: 0,
          };

      // Also re-applies the account's channel locks: with this workspace's
      // channels gone, previously locked ones may fit again.
      await this.lookup.applyLimitsToAllWorkspaces(ownerId, planCode, addons);
    } catch (error) {
      this.logger.error(
        `Failed to re-apply limits after deleting workspace ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { message: 'Workspace permanently deleted' };
  }

  /**
   * The DELETE, with the owner's workspace rows locked (FOR UPDATE, in id
   * order so two deletes never deadlock) while it counts what is left. Two
   * parallel deletes of an owner's last two workspaces then run one after
   * the other, and the second sees zero left and cancels the plan; unlocked,
   * each counted the other and neither cancelled. The lock is held for this
   * one short transaction only: no provider or Redis call runs inside it.
   *
   * The scheduled posts are read here too, before the cascade takes them
   * and the job ids recorded on them. null: the workspace is already gone.
   */
  private async deleteLocked(
    workspaceId: string,
    ownerId: string,
  ): Promise<{
    scheduledPosts: { id: string; jobId: string | null }[];
    ownedAfter: number;
  } | null> {
    return this.db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.ownerId, ownerId))
        .orderBy(workspace.id)
        .for('update');
      if (!owned.some((w) => w.id === workspaceId)) return null;

      const scheduledPosts = await tx
        .select({ id: posts.id, jobId: posts.jobId })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
          ),
        );

      await tx.delete(workspace).where(eq(workspace.id, workspaceId));
      return { scheduledPosts, ownedAfter: owned.length - 1 };
    });
  }

  /**
   * Both job ids a scheduled post can have (PostService.cancelPublishJobs):
   * the composer's `composer-publish-<id>` and whatever `posts.job_id`
   * names. A job left behind finds its post gone and does nothing, so a
   * failure is only logged.
   */
  private async cancelPublishJobs(
    workspaceId: string,
    scheduled: { id: string; jobId: string | null }[],
  ): Promise<void> {
    let failed = 0;
    for (const post of scheduled) {
      const ids = new Set([`composer-publish-${post.id}`]);
      if (post.jobId) ids.add(post.jobId);
      for (const jobId of ids) {
        try {
          const job = await this.publishingQueue.getJob(jobId);
          if (job) await job.remove();
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `Could not cancel job ${jobId} of deleted workspace ${workspaceId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    if (failed > 0) {
      this.logger.warn(
        `Deleted workspace ${workspaceId}: ${failed} publish job(s) left in Redis`,
      );
    }
  }

  /**
   * The owner's last workspace is gone: a paid plan would bill on for
   * nothing, so it ends at the period end. isCancellable decides, the same
   * rule the deletion preview's `cancelsPlan` warns from. Never throws: the
   * workspace is already deleted.
   */
  private async cancelPaidPlan(
    ownerId: string,
    callerId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      const subscription = await this.lookup.findByUserId(ownerId);
      if (!isCancellable(subscription, true)) return;
      await this.subscriptionService.cancelForAccount(ownerId, true, {
        changedByUserId: callerId,
      });
    } catch (error) {
      this.logger.error(
        `Failed to cancel the subscription of ${ownerId} after deleting their last workspace ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `plans.name` of the owner's live subscription, else the free plan's
   * name. Never null: a missing FREE row still reads 'Free'.
   */
  private async ownerPlanName(ownerId: string): Promise<string> {
    const [live] = await this.db
      .select({ name: plans.name })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(
        and(
          eq(subscriptions.userId, ownerId),
          inArray(subscriptions.status, LIVE_SUBSCRIPTION_STATUSES),
        ),
      )
      .limit(1);
    if (live) return live.name;
    const [free] = await this.db
      .select({ name: plans.name })
      .from(plans)
      .where(eq(plans.code, 'FREE'))
      .limit(1);
    return free?.name ?? 'Free';
  }

  /** How many workspaces the account will own once `excludingId` is gone. */
  private async countOwnedWorkspaces(
    userId: string,
    excludingId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(workspace)
      .where(and(eq(workspace.ownerId, userId), ne(workspace.id, excludingId)));
    return Number(row?.n ?? 0);
  }

  /**
   * The point below which a purchased workspace slot is no longer needed.
   *
   * `purchasedFloor` is the plan's own allowance: while the account owns more
   * than that, every workspace above it is one it paid extra for, so deleting
   * one should hand a slot back. At or below it, the plan already covers what
   * remains and there is nothing to refund.
   */
  private async includedWorkspaces(
    userId: string,
  ): Promise<{ purchasedFloor: number }> {
    const subscription = await this.lookup.findByUserId(userId);
    const planCode =
      subscription && subscription.status === 'active'
        ? subscription.planCode
        : 'FREE';
    const plan = await this.lookup.getPlanLimits(planCode);
    return { purchasedFloor: plan.maxWorkspaces };
  }
}
