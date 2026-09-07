import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { workspace, workspaceUsage, Workspace } from 'src/drizzle/schema';
import { and, count, eq, ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { UsageService } from 'src/billing/services/usage.service';
import { UsersService } from 'src/users/users.service';
import { SubscriptionService } from 'src/billing/services/subscription.service';
import { SubscriptionLookupService } from 'src/billing/services/subscription-lookup.service';
import { AddonService } from 'src/billing/services/addon.service';
import { AccountChannelsService } from 'src/billing/services/account-channels.service';
import { resolveWorkspaceLimits } from 'src/billing/services/limit-resolver.util';

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
    private accountChannels: AccountChannelsService,
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

  async update(
    workspaceId: string,
    updateWorkspaceDto: UpdateWorkspaceDto,
    userId: string,
  ): Promise<Workspace> {
    const existingWorkspace = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!existingWorkspace) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    if (existingWorkspace.ownerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to update this workspace',
      );
    }

    if (updateWorkspaceDto.name) {
      const newSlug = this.generateSlug(updateWorkspaceDto.name);

      if (newSlug !== existingWorkspace.slug) {
        const slugExists = await this.db.query.workspace.findFirst({
          where: and(
            eq(workspace.slug, newSlug),
            sql`${workspace.id} != ${workspaceId}`,
          ),
        });

        if (slugExists) {
          throw new ConflictException(
            `Workspace with name "${updateWorkspaceDto.name}" already exists. Please choose a different name.`,
          );
        }

        const [updatedWorkspace] = await this.db
          .update(workspace)
          .set({
            ...updateWorkspaceDto,
            slug: newSlug,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, workspaceId))
          .returning();

        return updatedWorkspace;
      }
    }

    const [updatedWorkspace] = await this.db
      .update(workspace)
      .set({
        ...updateWorkspaceDto,
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, workspaceId))
      .returning();

    return updatedWorkspace;
  }

  async remove(
    workspaceId: string,
    userId: string,
  ): Promise<{ message: string }> {
    const existingWorkspace = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!existingWorkspace) {
      throw new NotFoundException(
        `Workspace with id "${workspaceId}" not found`,
      );
    }

    if (existingWorkspace.ownerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this workspace',
      );
    }

    // Give back the workspace slot BEFORE deleting, while this workspace still
    // exists for removeAddon to verify ownership against.
    //
    // Without this the customer keeps paying an EXTRA_WORKSPACE line for a
    // workspace that no longer exists, every month, until they notice. Only
    // reduce when the account is actually over its included allowance —
    // deleting a workspace that the plan already covers should cost nothing.
    try {
      const ownedAfter = await this.countOwnedWorkspaces(userId, workspaceId);
      const included = await this.includedWorkspaces(userId);

      if (ownedAfter < included.purchasedFloor) {
        await this.addonService.removeAddon(
          workspaceId,
          userId,
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

    await this.db.delete(workspace).where(eq(workspace.id, workspaceId));

    // Remaining workspaces re-derive their limits: deleting the primary one
    // promotes the next-oldest, and nothing else recomputes the fan-out.
    // Channels are pooled, so freeing this workspace's channels may also let
    // previously locked channels come back.
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

      await this.lookup.applyLimitsToAllWorkspaces(userId, planCode, addons);
      await this.accountChannels.reconcileLocks(userId);
    } catch (error) {
      this.logger.error(
        `Failed to re-apply limits after deleting workspace ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { message: 'Workspace permanently deleted' };
  }

  /** How many workspaces the account will own once `excludingId` is gone. */
  private async countOwnedWorkspaces(
    userId: string,
    excludingId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(workspace)
      .where(
        and(eq(workspace.ownerId, userId), ne(workspace.id, excludingId)),
      );
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
