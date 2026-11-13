import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { and, inArray, notInArray } from 'drizzle-orm';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspace,
  workspaceUsage,
  socialMediaChannels,
  Subscription,
  INTEGRATION_PLATFORMS,
} from '../../drizzle/schema';
import { PlanLimits, AddonQuantities, UNLIMITED } from './limit-resolver.util';
import {
  buildUsageFanout,
  pickPrimaryWorkspaceId,
  WorkspaceRef,
} from './usage-fanout.util';
import {
  planChannelLocks,
  planChannelReleases,
  LockableChannel,
} from './channel-lock.util';
import { FREE_STORAGE_BYTES } from '../plan-storage';

/** Limits every account falls back to when it has no subscription row. */
const FREE_FALLBACK: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
  storageBytesPerWorkspace: FREE_STORAGE_BYTES,
};

interface AddonItemRow {
  itemType: string;
  quantity: number;
}

/**
 * The single seam through which billing finds "the subscription that applies".
 *
 * Subscriptions are account-scoped, but most of the app still asks its
 * questions per workspace ("can this workspace add a channel?"). Rather than
 * teach 37 call sites to resolve an owner, they all come through here.
 */
@Injectable()
export class SubscriptionLookupService {
  private readonly logger = new Logger(SubscriptionLookupService.name);

  async findByUserId(userId: string): Promise<Subscription | null> {
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getOwnerId(workspaceId: string): Promise<string | null> {
    const rows = await db
      .select({ ownerId: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  }

  /** The subscription that pays for this workspace: its owner's. */
  async findByWorkspaceId(workspaceId: string): Promise<Subscription | null> {
    const ownerId = await this.getOwnerId(workspaceId);
    if (!ownerId) return null;
    return this.findByUserId(ownerId);
  }

  /**
   * A missing plan row falls back to FREE rather than throwing. Billing is
   * read on hot paths (guards, post creation); an unknown plan code must
   * degrade to the smallest allowance, never take the request down.
   */
  async getPlanLimits(planCode: string): Promise<PlanLimits> {
    const rows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, planCode))
      .limit(1);

    const plan = rows[0];
    if (!plan) {
      this.logger.warn(
        `Plan "${planCode}" not found — falling back to FREE limits`,
      );
      return FREE_FALLBACK;
    }

    return {
      channelsPerWorkspace: plan.channelsPerWorkspace,
      membersPerWorkspace: plan.membersPerWorkspace,
      maxWorkspaces: plan.maxWorkspaces,
      aiTokensPerMonth: plan.aiTokensPerMonth,
      queuedPostsPerChannel: plan.queuedPostsPerChannel,
      storageBytesPerWorkspace: plan.storageBytesPerWorkspace,
    };
  }

  /** Pure: fold subscription items into add-on quantities. */
  static toAddonQuantities(
    items: AddonItemRow[],
    unitsByType: Record<string, number>,
  ): AddonQuantities {
    const quantities: AddonQuantities = {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    };

    for (const item of items) {
      const units = unitsByType[item.itemType] ?? 1;
      if (item.itemType === 'EXTRA_CHANNEL') {
        quantities.extraChannels += item.quantity;
      } else if (item.itemType === 'EXTRA_MEMBER') {
        quantities.extraMembers += item.quantity;
      } else if (item.itemType === 'EXTRA_WORKSPACE') {
        quantities.extraWorkspaces += item.quantity;
      } else if (item.itemType === 'EXTRA_AI_TOKENS') {
        quantities.extraAiTokens += item.quantity * units;
      }
      // BASE_PLAN and anything unrecognised contribute nothing.
    }

    return quantities;
  }

  async getAddonQuantities(subscriptionId: number): Promise<AddonQuantities> {
    const items = await db
      .select({
        itemType: subscriptionItems.itemType,
        quantity: subscriptionItems.quantity,
      })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));

    // An AI-token pack grants 5000 tokens per purchased unit, not 1.
    const unitsByType: Record<string, number> = { EXTRA_AI_TOKENS: 5000 };

    return SubscriptionLookupService.toAddonQuantities(items, unitsByType);
  }

  /**
   * Every workspace the account owns, oldest first.
   *
   * The `(createdAt, id)` order is load-bearing, not cosmetic:
   * `pickPrimaryWorkspaceId` breaks a createdAt tie by input order, so an
   * unordered query could nominate a different "primary" workspace on each
   * call and silently migrate the account's channel allowance between them.
   */
  async listOwnedWorkspaces(userId: string): Promise<WorkspaceRef[]> {
    return db
      .select({ id: workspace.id, createdAt: workspace.createdAt })
      .from(workspace)
      .where(eq(workspace.ownerId, userId))
      .orderBy(workspace.createdAt, workspace.id);
  }

  /**
   * The workspace that carries the account's purchased channels and seats: its
   * oldest. Null when the account owns none.
   */
  async getPrimaryWorkspaceId(userId: string): Promise<string | null> {
    return pickPrimaryWorkspaceId(await this.listOwnedWorkspaces(userId));
  }

  /**
   * Write plan limits to EVERY workspace the account owns.
   *
   * Under workspace-scoped billing each of these writes targeted a single
   * usage row. One subscription now covers many workspaces, so writing one row
   * would leave the rest on their previous limits with no error raised. Every
   * plan change, add-on change, downgrade, and reset-to-FREE goes through here.
   */
  async applyLimitsToAllWorkspaces(
    userId: string,
    planCode: string,
    addons: AddonQuantities,
  ): Promise<void> {
    const workspaces = await this.listOwnedWorkspaces(userId);

    if (workspaces.length === 0) return;

    const plan = await this.getPlanLimits(planCode);
    const writes = buildUsageFanout(workspaces, plan, addons);

    for (const write of writes) {
      await db
        .update(workspaceUsage)
        .set({
          channelsLimit: write.channelsLimit,
          membersLimit: write.membersLimit,
          aiTokensLimit: write.aiTokensLimit,
          storageBytesLimit: write.storageBytesLimit,
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.workspaceId, write.workspaceId));
    }

    this.logger.log(
      `Applied ${planCode} limits to ${writes.length} workspace(s) for user ${userId}`,
    );

    const channelCeiling =
      plan.channelsPerWorkspace === UNLIMITED
        ? UNLIMITED
        : plan.channelsPerWorkspace + addons.extraChannels;
    await this.applyAccountChannelLocks(userId, channelCeiling);
  }

  /**
   * Every billable channel the account holds, across all its workspaces.
   *
   * Integrations (cloud storage, calendars) never hold a paid slot, so they
   * are neither counted nor ever locked. Filtered by platform rather than the
   * stored `category` column, for the reason AccountChannelsService gives.
   */
  private async listBillableChannels(
    userId: string,
  ): Promise<LockableChannel[]> {
    return db
      .select({
        id: socialMediaChannels.id,
        createdAt: socialMediaChannels.createdAt,
        isActive: socialMediaChannels.isActive,
      })
      .from(socialMediaChannels)
      .innerJoin(workspace, eq(workspace.id, socialMediaChannels.workspaceId))
      .where(
        and(
          eq(workspace.ownerId, userId),
          notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
        ),
      );
  }

  /**
   * Bring the account's channels in line with its ceiling, after a billing
   * change that states the new plan.
   *
   * Excess channels are LOCKED, never disconnected: tokens, history and
   * scheduled posts survive, and an upgrade releases them again. The oldest
   * channels are the ones kept - the customer makes no decision at the moment
   * their plan lapses, and the same set survives however often this runs.
   *
   * ACCOUNT-wide, like the ceiling itself (AccountChannelsService): channels
   * are pooled across workspaces. This used to run per workspace against
   * `workspace_usage.channels_limit`, which counted integrations as channels
   * and gives every non-primary workspace a limit of 0 - so a Google Drive or
   * Dropbox pushed a real channel over the line, and a plan change locked
   * every channel outside the oldest workspace.
   */
  async applyAccountChannelLocks(userId: string, limit: number): Promise<void> {
    const channels = await this.listBillableChannels(userId);
    if (channels.length === 0) return;

    const plan = planChannelLocks(channels, limit);
    await this.setChannelsActive(plan.lock, false);
    await this.setChannelsActive(plan.unlock, true);

    if (plan.lock.length > 0 || plan.unlock.length > 0) {
      this.logger.log(
        `Channel locks for user ${userId} (ceiling ${limit}): locked ${plan.lock.length}, released ${plan.unlock.length}`,
      );
    }
  }

  /**
   * Let locked channels back into slots that are free, never lock one.
   * See `planChannelReleases` for why the paths without a stated plan only
   * ever release. Returns the ids it released.
   */
  async releaseAccountChannelLocks(
    userId: string,
    limit: number,
  ): Promise<number[]> {
    const channels = await this.listBillableChannels(userId);
    const release = planChannelReleases(channels, limit);
    await this.setChannelsActive(release, true);

    if (release.length > 0) {
      this.logger.log(
        `Released ${release.length} locked channel(s) into free slots for user ${userId}`,
      );
    }
    return release;
  }

  private async setChannelsActive(
    ids: number[],
    isActive: boolean,
  ): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(socialMediaChannels)
      .set({ isActive, updatedAt: new Date() })
      .where(inArray(socialMediaChannels.id, ids));
  }
}
