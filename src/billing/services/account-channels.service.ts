import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { eq, sql, count, and, notInArray } from 'drizzle-orm';
import { liveChannel } from '../../channels/lib/live-channel';
import { db } from '../../drizzle/db';
import {
  workspace,
  socialMediaChannels,
  INTEGRATION_PLATFORMS,
} from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { UNLIMITED } from './limit-resolver.util';
import { channelLimitReached } from './channel-limit.error';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import {
  PAID_ONLY_PLATFORMS,
  entitledPlanCode,
  isPaidOnlyPlatform,
  isPaidPlan,
  isPlatformAllowedOnPlan,
  planUpgradeRequired,
} from '../paid-only-platforms';

/** What the frontend needs to badge paid-only platforms on the connect UI. */
export interface PlatformAccess {
  /** The account's entitled plan is not FREE (see entitledPlanCode). */
  isPaidPlan: boolean;
  /** Platforms a NEW channel of which needs a paid plan. */
  paidOnlyPlatforms: SupportedPlatform[];
}

/**
 * Channels are pooled at the ACCOUNT level, not per workspace.
 *
 * A customer buys N channels and places them wherever they like: six channels
 * across two workspaces can sit 3+3, 5+1 or 6+0, and moving one between
 * workspaces costs nothing and changes no bill. This is the model Buffer
 * ("billed per channel rather than per brand or per client") and Publer ("the
 * number of your social accounts is not related to your Workspaces") both use.
 *
 * The per-workspace alternative forces a customer onboarding one more client to
 * buy a whole workspace even when they have spare channel capacity — the single
 * loudest complaint against Planable's pricing.
 *
 * Counting is a live COUNT over `social_media_channels`, not a stored counter,
 * so it cannot drift: a cascade-deleted workspace takes its channels out of the
 * total automatically.
 */
@Injectable()
export class AccountChannelsService {
  constructor(private readonly lookup: SubscriptionLookupService) {}

  /**
   * Only publishing channels consume a paid slot; cloud-storage and calendar
   * integrations do not.
   *
   * Filtered by PLATFORM rather than the stored `category` column: that column
   * defaults to 'social' and was only backfilled where its migration ran, so a
   * row can mislabel itself. The platform is always correct.
   */
  private billableOnly() {
    // A disconnected channel (kept as history) gave its slot back.
    return and(
      notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
      liveChannel(),
    );
  }

  /** Every channel the account holds, across all its workspaces. */
  async countForUser(userId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(socialMediaChannels)
      .innerJoin(workspace, eq(workspace.id, socialMediaChannels.workspaceId))
      .where(and(eq(workspace.ownerId, userId), this.billableOnly()));

    return Number(row?.n ?? 0);
  }

  /**
   * The account's channel ceiling: the plan's allowance plus whatever it
   * bought. `-1` means unlimited.
   */
  async limitForUser(userId: string): Promise<number> {
    const subscription = await this.lookup.findByUserId(userId);

    const planCode = entitledPlanCode(subscription);

    const plan = await this.lookup.getPlanLimits(planCode);
    if (plan.channelsPerWorkspace === UNLIMITED) return UNLIMITED;

    const addons = subscription
      ? await this.lookup.getAddonQuantities(subscription.id)
      : {
          extraChannels: 0,
          extraMembers: 0,
          extraWorkspaces: 0,
          extraAiTokens: 0,
        };

    return plan.channelsPerWorkspace + addons.extraChannels;
  }

  async getUsage(
    userId: string,
  ): Promise<{ used: number; limit: number; available: number }> {
    const [used, limit] = await Promise.all([
      this.countForUser(userId),
      this.limitForUser(userId),
    ]);

    return {
      used,
      limit,
      available: limit === UNLIMITED ? Number.MAX_SAFE_INTEGER : limit - used,
    };
  }

  /**
   * Refuse a new channel when the account is at its ceiling, holding a lock for
   * the caller's whole insert.
   *
   * Pooled counting makes the check-then-insert race materially more likely
   * than it was per workspace: two connections landing in *different*
   * workspaces of the same account now contend, and there is no single usage
   * row to serialise on. `pg_advisory_xact_lock` keyed on the account gives us
   * that serialisation point; it releases when the surrounding transaction
   * ends, so the caller MUST run inside one for the guarantee to hold.
   *
   * `hashtextextended` maps the uuid to the bigint the lock API takes.
   */
  async enforceWithinTransaction(
    tx: { execute: (q: unknown) => Promise<unknown> },
    userId: string,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    );

    const { used, limit } = await this.getUsage(userId);
    if (limit === UNLIMITED) return;

    if (used >= limit) {
      throw channelLimitReached(used, limit);
    }
  }

  /**
   * A slot may have come free: let locked channels back into it, oldest
   * first, and never lock one (`planChannelReleases` says why this path only
   * releases; a billing change locks through
   * SubscriptionLookupService.applyAccountChannelLocks). Locked channels keep
   * their tokens, history and scheduled posts, so a released one simply
   * publishes again.
   *
   * Called when a channel is disconnected or reconnected, and by the nightly
   * sweep (ChannelLockSweepService). Returns the ids it released.
   */
  async releaseFreedSlots(userId: string): Promise<number[]> {
    const limit = await this.limitForUser(userId);
    return this.lookup.releaseAccountChannelLocks(userId, limit);
  }

  /** The plan this account is entitled to right now (entitledPlanCode). */
  async planCodeForUser(userId: string): Promise<string> {
    return entitledPlanCode(await this.lookup.findByUserId(userId));
  }

  async platformAccessForUser(userId: string): Promise<PlatformAccess> {
    return {
      isPaidPlan: isPaidPlan(await this.planCodeForUser(userId)),
      paidOnlyPlatforms: [...PAID_ONLY_PLATFORMS],
    };
  }

  /**
   * Refuse a NEW channel of a paid-only platform (X) on a free account: 403
   * PLAN_UPGRADE_REQUIRED. Called by ChannelService.createChannel just before
   * it inserts a new row - the one write every connect path ends in (OAuth
   * callback, connect links, the per-platform connect routes, complete-oauth)
   * - so a start that was bypassed still cannot add the channel. Reconnecting
   * a channel the workspace already holds never comes here.
   */
  async assertPlatformAllowed(
    userId: string,
    platform: SupportedPlatform,
  ): Promise<void> {
    if (!isPaidOnlyPlatform(platform)) return;
    const planCode = await this.planCodeForUser(userId);
    if (!isPlatformAllowedOnPlan(platform, planCode)) {
      throw planUpgradeRequired(platform);
    }
  }

  /**
   * The same gate at the OAuth start, so a free workspace is told before it
   * goes through X's consent screen. A workspace that already holds a channel
   * of the platform (any state, disconnected included) may start: the
   * frontend reconnects through the same initiate route, and the start does
   * not know yet which account will come back - if it is a new one, the
   * final write (assertPlatformAllowed) refuses it.
   */
  async assertCanStartConnect(
    workspaceId: string,
    platform: SupportedPlatform,
  ): Promise<void> {
    if (!isPaidOnlyPlatform(platform)) return;
    if (await this.hasChannelOn(workspaceId, platform)) return;
    await this.assertPlatformAllowed(await this.ownerOf(workspaceId), platform);
  }

  /**
   * Refuse to CREATE a connect link that offers a paid-only platform (X) when
   * the workspace owner is not on a paid plan: the same 403
   * PLAN_UPGRADE_REQUIRED, so the sender hears it when making the link, not
   * the client at the end of it. No `hasChannelOn` exemption here: a link
   * invites NEW accounts, which is exactly what the plan gates. Links already
   * created are not touched; the start gate refuses them when visited.
   */
  async assertCanOfferNetworks(
    workspaceId: string,
    networks: readonly string[],
  ): Promise<void> {
    const gated = networks.filter(isPaidOnlyPlatform);
    if (gated.length === 0) return;
    const planCode = await this.planCodeForUser(
      await this.ownerOf(workspaceId),
    );
    for (const platform of gated) {
      if (!isPlatformAllowedOnPlan(platform, planCode)) {
        throw planUpgradeRequired(platform as SupportedPlatform);
      }
    }
  }

  /** Does this workspace hold any channel row of this platform? */
  async hasChannelOn(
    workspaceId: string,
    platform: SupportedPlatform,
  ): Promise<boolean> {
    const [row] = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.platform, platform),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Resolve a workspace to its owning account. */
  async ownerOf(workspaceId: string): Promise<string> {
    const ownerId = await this.lookup.getOwnerId(workspaceId);
    if (!ownerId) {
      throw new InternalServerErrorException(
        `Workspace ${workspaceId} has no owner`,
      );
    }
    return ownerId;
  }
}
