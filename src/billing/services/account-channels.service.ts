import {
  Injectable,
  Logger,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { eq, sql, count, inArray, and, notInArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  workspace,
  socialMediaChannels,
  INTEGRATION_PLATFORMS,
} from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { UNLIMITED } from './limit-resolver.util';

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
  private readonly logger = new Logger(AccountChannelsService.name);

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
    return notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS);
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

    const planCode =
      subscription && subscription.status === 'active'
        ? subscription.planCode
        : 'FREE';

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
      throw new ForbiddenException(
        `Channel limit reached (${used}/${limit}). ` +
          'Upgrade your plan or purchase additional channels.',
      );
    }
  }

  /**
   * Which of the account's channels exceed its ceiling.
   *
   * Ordered oldest-first, tie-broken by id, so the survivors are stable across
   * runs — the same rule `planChannelLocks` applies within a workspace, lifted
   * to the account now that the ceiling lives there.
   */
  async findOverLimitChannelIds(userId: string): Promise<number[]> {
    const limit = await this.limitForUser(userId);
    if (limit === UNLIMITED) return [];

    const channels = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .innerJoin(workspace, eq(workspace.id, socialMediaChannels.workspaceId))
      .where(and(eq(workspace.ownerId, userId), this.billableOnly()))
      .orderBy(socialMediaChannels.createdAt, socialMediaChannels.id);

    return channels.slice(Math.max(0, limit)).map((c) => c.id);
  }

  /**
   * Lock what is over the ceiling and release what is under it again.
   *
   * Locked channels keep their tokens, history and scheduled posts — they
   * simply cannot publish (`getAccessToken` refuses them) — and an upgrade
   * brings them straight back.
   */
  async reconcileLocks(userId: string): Promise<void> {
    const overLimit = new Set(await this.findOverLimitChannelIds(userId));

    const channels = await db
      .select({
        id: socialMediaChannels.id,
        isActive: socialMediaChannels.isActive,
      })
      .from(socialMediaChannels)
      .innerJoin(workspace, eq(workspace.id, socialMediaChannels.workspaceId))
      .where(and(eq(workspace.ownerId, userId), this.billableOnly()));

    const toLock = channels
      .filter((c) => overLimit.has(c.id) && c.isActive !== false)
      .map((c) => c.id);

    const toUnlock = channels
      .filter((c) => !overLimit.has(c.id) && c.isActive === false)
      .map((c) => c.id);

    if (toLock.length > 0) {
      await db
        .update(socialMediaChannels)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(socialMediaChannels.id, toLock));
      this.logger.log(
        `Locked ${toLock.length} channel(s) over the ceiling for user ${userId}`,
      );
    }

    if (toUnlock.length > 0) {
      await db
        .update(socialMediaChannels)
        .set({ isActive: true, updatedAt: new Date() })
        .where(inArray(socialMediaChannels.id, toUnlock));
      this.logger.log(
        `Released ${toUnlock.length} channel(s) for user ${userId}`,
      );
    }
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
