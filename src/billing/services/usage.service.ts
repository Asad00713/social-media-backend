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
  subscriptions,
  plans,
  subscriptionItems,
  workspace,
  workspaceInvitation,
  NewUsageEvent,
} from '../../drizzle/schema';

export type ResourceType = 'CHANNEL' | 'MEMBER' | 'WORKSPACE';
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
}

export interface WorkspaceLimits {
  maxWorkspaces: number;
  currentWorkspaces: number;
  workspacesAvailable: number;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  // Get usage limits for a workspace
  async getWorkspaceUsage(workspaceId: string): Promise<UsageLimits> {
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (usage.length === 0) {
      throw new NotFoundException('Workspace usage not found. Ensure subscription is active.');
    }

    const u = usage[0];
    return {
      channelsLimit: u.channelsLimit + u.extraChannelsPurchased,
      channelsCount: u.channelsCount,
      channelsAvailable: u.channelsLimit + u.extraChannelsPurchased - u.channelsCount,
      membersLimit: u.membersLimit + u.extraMembersPurchased,
      membersCount: u.membersCount,
      membersAvailable: u.membersLimit + u.extraMembersPurchased - u.membersCount,
      extraChannelsPurchased: u.extraChannelsPurchased,
      extraMembersPurchased: u.extraMembersPurchased,
    };
  }

  // Check if user can create more workspaces
  async getWorkspaceLimits(userId: string): Promise<WorkspaceLimits> {
    // Get user's workspaces
    const userWorkspaces = await db
      .select()
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    // Get the highest plan limit from user's subscriptions
    let maxWorkspaces = 1; // Default FREE plan limit

    for (const ws of userWorkspaces) {
      const subscription = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.workspaceId, ws.id),
            eq(subscriptions.status, 'active'),
          ),
        )
        .limit(1);

      if (subscription.length > 0) {
        const plan = await db
          .select()
          .from(plans)
          .where(eq(plans.code, subscription[0].planCode))
          .limit(1);

        if (plan.length > 0 && plan[0].maxWorkspaces > maxWorkspaces) {
          maxWorkspaces = plan[0].maxWorkspaces;
        }

        // Check for extra workspaces purchased
        const extraWorkspaces = await db
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.subscriptionId, subscription[0].id),
              eq(subscriptionItems.itemType, 'EXTRA_WORKSPACE'),
            ),
          )
          .limit(1);

        if (extraWorkspaces.length > 0) {
          maxWorkspaces += extraWorkspaces[0].quantity;
        }
      }
    }

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
      throw new ForbiddenException(
        `Channel limit reached. You have ${usage.channelsCount}/${usage.channelsLimit} channels. ` +
          'Please upgrade your plan or purchase additional channels.',
      );
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
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'CHANNEL',
      'CHANNEL_ADDED',
      1,
      userId,
      resourceId,
    );
  }

  // Decrement channel count
  async decrementChannelCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'CHANNEL',
      'CHANNEL_REMOVED',
      -1,
      userId,
      resourceId,
    );
  }

  // Increment member count
  async incrementMemberCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'MEMBER',
      'MEMBER_ADDED',
      1,
      userId,
      resourceId,
    );
  }

  // Decrement member count
  async decrementMemberCount(
    workspaceId: string,
    userId: string,
    resourceId?: string,
  ): Promise<void> {
    await this.updateUsageCount(
      workspaceId,
      'MEMBER',
      'MEMBER_REMOVED',
      -1,
      userId,
      resourceId,
    );
  }

  // Core method to update usage counts
  private async updateUsageCount(
    workspaceId: string,
    resourceType: ResourceType,
    eventType: EventType,
    delta: number,
    userId: string,
    resourceId?: string,
  ): Promise<void> {
    // Get current usage
    const currentUsage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (currentUsage.length === 0) {
      this.logger.warn(`No usage record for workspace ${workspaceId}`);
      return;
    }

    const usage = currentUsage[0];
    let quantityBefore: number;
    let quantityAfter: number;

    if (resourceType === 'CHANNEL') {
      quantityBefore = usage.channelsCount;
      quantityAfter = Math.max(0, usage.channelsCount + delta);

      await db
        .update(workspaceUsage)
        .set({
          channelsCount: quantityAfter,
          lastCalculatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.id, usage.id));
    } else if (resourceType === 'MEMBER') {
      quantityBefore = usage.membersCount;
      quantityAfter = Math.max(0, usage.membersCount + delta);

      await db
        .update(workspaceUsage)
        .set({
          membersCount: quantityAfter,
          lastCalculatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.id, usage.id));
    } else {
      return;
    }

    // Log usage event
    await this.logUsageEvent(
      workspaceId,
      eventType,
      resourceType,
      quantityBefore,
      quantityAfter,
      delta,
      userId,
      resourceId,
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
  ): Promise<void> {
    await db.insert(usageEvents).values({
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

    this.logger.log(`Recalculated usage for workspace ${workspaceId}: ${membersCount} members`);
  }

  // Update limits when subscription changes (e.g., add-ons purchased)
  async updateWorkspaceLimits(
    workspaceId: string,
    updates: {
      channelsLimit?: number;
      membersLimit?: number;
      extraChannelsPurchased?: number;
      extraMembersPurchased?: number;
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

  // Check if downgrade is possible (usage within new limits)
  async canDowngrade(
    workspaceId: string,
    newPlanCode: string,
  ): Promise<{ canDowngrade: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Get current usage
    const currentUsage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (currentUsage.length === 0) {
      return { canDowngrade: true, issues: [] };
    }

    // Get new plan limits
    const newPlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, newPlanCode))
      .limit(1);

    if (newPlan.length === 0) {
      return { canDowngrade: false, issues: ['Plan not found'] };
    }

    const usage = currentUsage[0];
    const plan = newPlan[0];

    // Check channels
    if (usage.channelsCount > plan.channelsPerWorkspace) {
      issues.push(
        `You have ${usage.channelsCount} channels but the ${plan.name} plan only allows ${plan.channelsPerWorkspace}. ` +
          `Please remove ${usage.channelsCount - plan.channelsPerWorkspace} channel(s) first.`,
      );
    }

    // Check members
    if (usage.membersCount > plan.membersPerWorkspace) {
      issues.push(
        `You have ${usage.membersCount} members but the ${plan.name} plan only allows ${plan.membersPerWorkspace}. ` +
          `Please remove ${usage.membersCount - plan.membersPerWorkspace} member(s) first.`,
      );
    }

    return {
      canDowngrade: issues.length === 0,
      issues,
    };
  }
}
