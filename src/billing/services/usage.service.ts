import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  workspaceUsage,
  usageEvents,
  plans,
  workspace,
  workspaceInvitation,
  NewUsageEvent,
} from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { AccountChannelsService } from './account-channels.service';
import { resolveMaxWorkspaces } from './limit-resolver.util';
import { channelLimitReached } from './channel-limit.error';

/**
 * What a usage write needs: the pool, or a transaction holding the seat lock.
 *
 * Typed as just the `update` entry point rather than the whole DbType so a
 * caller can pass a Drizzle transaction without the two types having to match
 * structurally — they differ in ways none of this code touches.
 */
type UsageWriter = Pick<typeof db, 'update' | 'insert'>;

/** The same, for the audit-row insert. */
type UsageEventWriter = Pick<typeof db, 'insert'>;
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';

export type ResourceType = 'CHANNEL' | 'MEMBER' | 'WORKSPACE' | 'POST';
export type EventType =
  | 'CHANNEL_ADDED'
  | 'CHANNEL_REMOVED'
  | 'MEMBER_ADDED'
  | 'MEMBER_REMOVED'
  | 'WORKSPACE_CREATED'
  | 'WORKSPACE_DELETED';

export interface UsageLimits {
  channelsLimit: number;
  channelsCount: number;
  channelsAvailable: number;
  membersLimit: number;
  membersCount: number;
  membersAvailable: number;
  extraChannelsPurchased: number;
  extraMembersPurchased: number;
  aiTokensUsedThisMonth: number;
  aiTokensLimit: number;
  aiTokensRemaining: number;
  extraAiTokensPurchased: number;
  aiTokensResetDate: Date | null;
}

export interface WorkspaceLimits {
  maxWorkspaces: number;
  currentWorkspaces: number;
  workspacesAvailable: number;
}

/** One owned workspace's counted resources, for the downgrade check. */
export interface DowngradeWorkspaceUsage {
  workspaceName: string;
  channelsCount: number;
  membersCount: number;
}

/** The per-workspace ceilings of the plan being downgraded to. */
export interface DowngradePlanLimits {
  name: string;
  channelsPerWorkspace: number;
  membersPerWorkspace: number;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly lookup: SubscriptionLookupService,
    private readonly accountChannels: AccountChannelsService,
  ) {}

  // Get usage limits for a workspace
  async getWorkspaceUsage(workspaceId: string): Promise<UsageLimits> {
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (usage.length === 0) {
      throw new NotFoundException(
        'Workspace usage not found. Ensure subscription is active.',
      );
    }

    const u = usage[0];
    const totalAiTokens = u.aiTokensLimit + u.extraAiTokensPurchased;

    // Channels are pooled across the ACCOUNT, so the numbers a workspace shows
    // for them are the account's — the same ceiling and the same live count the
    // connect path enforces. Reading this workspace's own row here would show a
    // customer a limit that is not the one being applied to them.
    // Members stay per-workspace.
    const ownerId = await this.lookup.getOwnerId(workspaceId);
    const channels = ownerId
      ? await this.accountChannels.getUsage(ownerId)
      : { used: u.channelsCount, limit: u.channelsLimit, available: 0 };

    return {
      channelsLimit: channels.limit,
      channelsCount: channels.used,
      channelsAvailable: Math.max(0, channels.available),
      membersLimit: u.membersLimit + u.extraMembersPurchased,
      membersCount: u.membersCount,
      membersAvailable:
        u.membersLimit + u.extraMembersPurchased - u.membersCount,
      extraChannelsPurchased: u.extraChannelsPurchased,
      extraMembersPurchased: u.extraMembersPurchased,
      aiTokensUsedThisMonth: u.aiTokensUsedThisMonth,
      aiTokensLimit: totalAiTokens,
      aiTokensRemaining: Math.max(0, totalAiTokens - u.aiTokensUsedThisMonth),
      extraAiTokensPurchased: u.extraAiTokensPurchased,
      aiTokensResetDate: u.aiTokensResetDate,
    };
  }

  /**
   * How many workspaces this account may own.
   *
   * Previously this looped over every workspace the user owned, read each
   * one's own subscription, and kept the LARGEST maxWorkspaces it found — a
   * workaround for workspace-scoped billing that was also exploitable (buy MAX
   * on one workspace, FREE on another, and MAX's allowance applied to both).
   * One account, one subscription, one lookup.
   */
  async getWorkspaceLimits(userId: string): Promise<WorkspaceLimits> {
    const userWorkspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.ownerId, userId), liveWorkspaces()));

    const subscription = await this.lookup.findByUserId(userId);

    // No subscription, or one that is not active, gets FREE's allowance.
    const planCode =
      subscription && subscription.status === 'active'
        ? subscription.planCode
        : 'FREE';

    const plan = await this.lookup.getPlanLimits(planCode);
    const addons = subscription
      ? await this.lookup.getAddonQuantities(subscription.id)
      : {
          extraChannels: 0,
          extraMembers: 0,
          extraWorkspaces: 0,
          extraAiTokens: 0,
        };

    const maxWorkspaces = resolveMaxWorkspaces(plan, addons);

    return {
      maxWorkspaces,
      currentWorkspaces: userWorkspaces.length,
      workspacesAvailable: maxWorkspaces - userWorkspaces.length,
    };
  }

  // Check if a channel can be added to workspace
  async canAddChannel(workspaceId: string): Promise<boolean> {
    const usage = await this.getWorkspaceUsage(workspaceId);
    return usage.channelsAvailable > 0;
  }

  // Check if a member can be added to workspace
  async canAddMember(workspaceId: string): Promise<boolean> {
    const usage = await this.getWorkspaceUsage(workspaceId);
    return usage.membersAvailable > 0;
  }

  // Check if user can create a new workspace
  async canCreateWorkspace(userId: string): Promise<boolean> {
    const limits = await this.getWorkspaceLimits(userId);
    return limits.workspacesAvailable > 0;
  }

  // Enforce channel limit - throws if limit exceeded
  async enforceChannelLimit(workspaceId: string): Promise<void> {
    const canAdd = await this.canAddChannel(workspaceId);
    if (!canAdd) {
      const usage = await this.getWorkspaceUsage(workspaceId);
      throw channelLimitReached(usage.channelsCount, usage.channelsLimit);
    }
  }

  // Enforce member limit - throws if limit exceeded
  async enforceMemberLimit(workspaceId: string): Promise<void> {
    const canAdd = await this.canAddMember(workspaceId);
    if (!canAdd) {
      const usage = await this.getWorkspaceUsage(workspaceId);
      throw new ForbiddenException(
        `Member limit reached. You have ${usage.membersCount}/${usage.membersLimit} members. ` +
          'Please upgrade your plan or purchase additional member slots.',
      );
    }
  }

  // Enforce workspace limit - throws if limit exceeded
  async enforceWorkspaceLimit(userId: string): Promise<void> {
    const canCreate = await this.canCreateWorkspace(userId);
    if (!canCreate) {
      const limits = await this.getWorkspaceLimits(userId);
      throw new ForbiddenException(
        `Workspace limit reached. You have ${limits.currentWorkspaces}/${limits.maxWorkspaces} workspaces. ` +
          'Please upgrade your plan or purchase additional workspace slots.',
      );
    }
  }

  // Increment channel count
  async incrementChannelCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
    tx?: UsageWriter,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'CHANNEL',
      'CHANNEL_ADDED',
      1,
      userId,
      resourceId,
      tx,
    );
  }

  // Decrement channel count
  async decrementChannelCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
    tx?: UsageWriter,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'CHANNEL',
      'CHANNEL_REMOVED',
      -1,
      userId,
      resourceId,
      tx,
    );
  }

  // Increment member count
  async incrementMemberCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
    tx?: UsageWriter,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'MEMBER',
      'MEMBER_ADDED',
      1,
      userId,
      resourceId,
      tx,
    );
  }

  // Decrement member count
  async decrementMemberCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
    tx?: UsageWriter,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'MEMBER',
      'MEMBER_REMOVED',
      -1,
      userId,
      resourceId,
      tx,
    );
  }

  /**
   * Apply a delta to one of the workspace's usage counters.
   *
   * ## Why the arithmetic happens in Postgres
   *
   * This used to SELECT the row, add the delta in JavaScript and write the
   * result back. Two accepts landing together both read 5 and both wrote 6, so
   * one seat was lost permanently — and `members_count` is what seat limits
   * and billing are measured against, so a workspace silently kept a seat it
   * had not paid for. A lost increment leaves no trace: the row stays
   * internally consistent, just wrong, and only a recalculation would notice.
   *
   * The delta is now an expression over the column, so Postgres reads and
   * writes under its own row lock and concurrent callers queue instead of
   * colliding. `GREATEST(0, …)` has to live inside that statement too — a
   * clamp applied to a value this process read is as racy as the increment
   * was.
   *
   * `returning()` gives the committed value, which is also what the usage
   * event logs: computing `quantityAfter` here would reintroduce the same
   * guess, and the log is meant to say what actually happened.
   *
   * ## Why it takes a transaction
   *
   * `lockWorkspaceSeats` (workspace-members.service.ts) holds
   * `pg_advisory_xact_lock` for the rest of its transaction. Running on the
   * module-level `db` meant a different connection, so this ran outside both
   * that transaction and its lock, and a rolled-back accept still counted a
   * seat. Callers inside a transaction pass `tx`; everyone else omits it and
   * gets the pool, as before.
   */
  private async updateUsageCount(
    workspaceId: string,
    resourceType: ResourceType,
    eventType: EventType,
    delta: number,
    userId: string,
    resourceId?: string,
    tx?: UsageWriter,
  ): Promise<void> {
    const writer: UsageWriter = tx ?? db;

    const column =
      resourceType === 'CHANNEL'
        ? workspaceUsage.channelsCount
        : resourceType === 'MEMBER'
          ? workspaceUsage.membersCount
          : null;
    if (!column) return;

    const bumped = sql`GREATEST(0, ${column} + ${delta})`;

    const [row] = await writer
      .update(workspaceUsage)
      .set({
        ...(resourceType === 'CHANNEL'
          ? { channelsCount: bumped }
          : { membersCount: bumped }),
        lastCalculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .returning({
        channelsCount: workspaceUsage.channelsCount,
        membersCount: workspaceUsage.membersCount,
      });

    if (!row) {
      this.logger.warn(`No usage record for workspace ${workspaceId}`);
      return;
    }

    const quantityAfter =
      resourceType === 'CHANNEL' ? row.channelsCount : row.membersCount;
    // Derived from the committed value rather than read beforehand: a second
    // writer may have moved the counter between the two, and the event log
    // should describe this statement's own effect.
    const quantityBefore = Math.max(0, quantityAfter - delta);

    // Logged through the same writer: on a transaction, the event row and the
    // counter commit together, so a rolled-back accept leaves neither behind.
    await this.logUsageEvent(
      workspaceId,
      eventType,
      resourceType,
      quantityBefore,
      quantityAfter,
      delta,
      userId,
      resourceId,
      writer,
    );
  }

  // Log usage event
  private async logUsageEvent(
    workspaceId: string,
    eventType: EventType,
    resourceType: ResourceType,
    quantityBefore: number,
    quantityAfter: number,
    quantityDelta: number,
    userId: string,
    resourceId?: string,
    tx?: UsageEventWriter,
  ): Promise<void> {
    await (tx ?? db).insert(usageEvents).values({
      workspaceId,
      eventType,
      resourceType,
      resourceId: resourceId || null,
      quantityBefore,
      quantityAfter,
      quantityDelta,
      triggeredByUserId: userId,
      metadata: {},
    } as NewUsageEvent);
  }

  // Recalculate workspace usage from actual data
  async recalculateWorkspaceUsage(workspaceId: string): Promise<void> {
    // Count actual members (ACCEPTED invitations)
    const [memberResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      );

    const membersCount = Number(memberResult?.count || 0);

    // TODO: Count actual channels when channel table exists
    // For now, we'll keep channels count as is
    const currentUsage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (currentUsage.length === 0) {
      return;
    }

    await db
      .update(workspaceUsage)
      .set({
        membersCount,
        lastCalculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.id, currentUsage[0].id));

    this.logger.log(
      `Recalculated usage for workspace ${workspaceId}: ${membersCount} members`,
    );
  }

  // Update limits when subscription changes (e.g., add-ons purchased)
  async updateWorkspaceLimits(
    workspaceId: string,
    updates: {
      channelsLimit?: number;
      membersLimit?: number;
      extraChannelsPurchased?: number;
      extraMembersPurchased?: number;
      extraAiTokensPurchased?: number;
    },
  ): Promise<void> {
    const currentUsage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (currentUsage.length === 0) {
      this.logger.warn(`No usage record for workspace ${workspaceId}`);
      return;
    }

    await db
      .update(workspaceUsage)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.id, currentUsage[0].id));

    this.logger.log(`Updated limits for workspace ${workspaceId}`);
  }

  /**
   * Pure: the downgrade complaints for ONE workspace, each naming its
   * workspace.
   *
   * A downgrade re-limits every workspace the account owns, so the workspace
   * blocking the user is often not the one they are looking at. "You have 7
   * channels" without saying where sends them hunting.
   */
  static describeDowngradeIssues(
    ws: DowngradeWorkspaceUsage,
    plan: DowngradePlanLimits,
  ): string[] {
    const issues: string[] = [];

    if (ws.channelsCount > plan.channelsPerWorkspace) {
      issues.push(
        `Workspace "${ws.workspaceName}" has ${ws.channelsCount} channels but the ${plan.name} plan only allows ${plan.channelsPerWorkspace}. ` +
          `Please remove ${ws.channelsCount - plan.channelsPerWorkspace} channel(s) from it first.`,
      );
    }

    if (ws.membersCount > plan.membersPerWorkspace) {
      issues.push(
        `Workspace "${ws.workspaceName}" has ${ws.membersCount} members but the ${plan.name} plan only allows ${plan.membersPerWorkspace}. ` +
          `Please remove ${ws.membersCount - plan.membersPerWorkspace} member(s) from it first.`,
      );
    }

    return issues;
  }

  /**
   * Can this ACCOUNT drop to `newPlanCode`?
   *
   * This used to validate a single workspace. A subscription now covers every
   * workspace the account owns and a downgrade re-limits all of them at once,
   * so checking one let a user pass validation while a SECOND workspace still
   * held channels over the new limit — downgrading it into a silently
   * over-limit state. Every owned workspace is checked, and each complaint
   * names the workspace that needs tidying.
   */
  async canDowngrade(
    userId: string,
    newPlanCode: string,
  ): Promise<{ canDowngrade: boolean; issues: string[] }> {
    // Get new plan limits
    const newPlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, newPlanCode))
      .limit(1);

    if (newPlan.length === 0) {
      return { canDowngrade: false, issues: ['Plan not found'] };
    }

    const plan = newPlan[0];

    // Every workspace the account owns, with its usage row. A workspace with no
    // usage row has no counted resources to be over-limit on, so an inner join
    // (which drops it) is the same answer as counting it at zero.
    const rows = await db
      .select({
        workspaceName: workspace.name,
        channelsCount: workspaceUsage.channelsCount,
        membersCount: workspaceUsage.membersCount,
      })
      .from(workspace)
      .innerJoin(workspaceUsage, eq(workspaceUsage.workspaceId, workspace.id))
      .where(eq(workspace.ownerId, userId))
      .orderBy(workspace.createdAt, workspace.id);

    const issues = rows.flatMap((row) =>
      UsageService.describeDowngradeIssues(row, plan),
    );

    return {
      canDowngrade: issues.length === 0,
      issues,
    };
  }
}
