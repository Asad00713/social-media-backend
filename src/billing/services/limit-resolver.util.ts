/**
 * Pure limit math for account-scoped billing. No DB, no NestJS — the numbers a
 * user is entitled to, derived from their single subscription.
 */

/** Sentinel: the plan places no ceiling on this resource. */
export const UNLIMITED = -1;

export interface PlanLimits {
  channelsPerWorkspace: number;
  membersPerWorkspace: number;
  maxWorkspaces: number;
  aiTokensPerMonth: number;
  queuedPostsPerChannel: number;
}

export interface AddonQuantities {
  extraChannels: number;
  extraMembers: number;
  extraWorkspaces: number;
  /** Already multiplied by addon_pricing.units_per_quantity (a pack = 5000). */
  extraAiTokens: number;
}

export interface ResolvedWorkspaceLimits {
  channelsLimit: number;
  membersLimit: number;
  aiTokensLimit: number;
  queuedPostsPerChannel: number;
}

/**
 * Resolve one workspace's BASE limits from the owner's plan.
 *
 * The returned limits deliberately EXCLUDE purchased add-ons. `workspace_usage`
 * stores the base allowance in `channelsLimit`/`membersLimit`/`aiTokensLimit`
 * and the purchased amount separately in `extra*Purchased`, and every one of
 * the eight readers across the codebase computes the effective ceiling as
 * `limit + extraPurchased` (usage.service, dashboard.service, channel.service,
 * admin.service, ai-token.service, token-tracking.service).
 *
 * Adding add-ons here as well made every add-on count twice: PRO (8 channels)
 * plus 3 EXTRA_CHANNEL yielded 14 usable channels for 11 paid. AI tokens were
 * worse, since a pack multiplies by 5000. `addon.service` even recovers the
 * base with `channelsLimit - extraChannelsPurchased`, which only holds if this
 * function returns the base alone.
 *
 * `isPrimaryWorkspace` decides where purchased channels and members land. A
 * workspace bought via EXTRA_WORKSPACE arrives EMPTY: channel limits are
 * per-workspace, so if a purchased workspace carried the tier's channel
 * allowance, buying a workspace would be a cheaper route to channels whenever
 * price(EXTRA_WORKSPACE) < channelsPerWorkspace x price(EXTRA_CHANNEL). Zero
 * closes that arbitrage — workspaces and channels are priced independently.
 */
export function resolveWorkspaceLimits(
  plan: PlanLimits,
  addons: AddonQuantities,
  isPrimaryWorkspace: boolean,
): ResolvedWorkspaceLimits {
  if (!isPrimaryWorkspace) {
    return {
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: plan.aiTokensPerMonth,
      queuedPostsPerChannel: plan.queuedPostsPerChannel,
    };
  }

  return {
    channelsLimit: plan.channelsPerWorkspace,
    membersLimit: plan.membersPerWorkspace,
    aiTokensLimit: plan.aiTokensPerMonth,
    queuedPostsPerChannel: plan.queuedPostsPerChannel,
  };
}

/** How many workspaces the account may own: the tier plus what it bought. */
export function resolveMaxWorkspaces(
  plan: PlanLimits,
  addons: AddonQuantities,
): number {
  return plan.maxWorkspaces + addons.extraWorkspaces;
}

/**
 * May another post be queued on this channel?
 *
 * `currentQueued` is a live COUNT of posts already in `scheduled` status, so it
 * self-corrects: publishing moves a post out of `scheduled` and frees the slot
 * with no bookkeeping.
 */
export function canQueuePost(
  queuedPostsPerChannel: number,
  currentQueued: number,
): boolean {
  if (queuedPostsPerChannel === UNLIMITED) return true;
  return currentQueued < queuedPostsPerChannel;
}
