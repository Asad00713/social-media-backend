import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspace,
  Subscription,
} from '../../drizzle/schema';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';

/** Limits every account falls back to when it has no subscription row. */
const FREE_FALLBACK: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
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
}
