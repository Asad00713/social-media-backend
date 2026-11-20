import { ForbiddenException } from '@nestjs/common';
import type { SupportedPlatform } from '../drizzle/schema/channels.schema';
import type { Subscription } from '../drizzle/schema';

/**
 * Platforms a workspace may only NEWLY connect on a paid plan.
 *
 * X is here because its API writes cost us money (a paid X API tier), so a
 * free plan cannot carry them. The gate is on connecting a new channel only:
 * an X channel a workspace already holds keeps posting and reporting on any
 * plan, and reconnecting it is always allowed.
 *
 * The single source of truth for "paid-only": the connect gates
 * (AccountChannelsService.assertPlatformAllowed / assertCanStartConnect) and
 * what the frontend is told (`GET /billing/workspaces/:id/usage`) all read
 * this list. Each entry carries the `feature` name the 403 reports.
 */
export const PAID_ONLY_FEATURE: Partial<Record<SupportedPlatform, string>> = {
  twitter: 'x',
};

/** Display names for the refusal message. */
const PAID_ONLY_LABEL: Partial<Record<SupportedPlatform, string>> = {
  twitter: 'X',
};

export const PAID_ONLY_PLATFORMS = Object.keys(
  PAID_ONLY_FEATURE,
) as SupportedPlatform[];

export const PLAN_UPGRADE_REQUIRED = 'PLAN_UPGRADE_REQUIRED' as const;

/** The plan code nothing is billed for. */
export const FREE_PLAN_CODE = 'FREE';

export function isPaidOnlyPlatform(platform: string): boolean {
  return (PAID_ONLY_PLATFORMS as readonly string[]).includes(platform);
}

export function isPaidPlan(planCode: string): boolean {
  return planCode !== FREE_PLAN_CODE;
}

/**
 * The plan an account is ENTITLED to: its plan while the subscription is
 * `active` (which includes one cancelling at its period end - access runs to
 * that date), FREE otherwise (no subscription, trialing, past_due, paused,
 * canceled). The same rule the channel and workspace ceilings apply
 * (AccountChannelsService.limitForUser, UsageService.getWorkspaceLimits), so
 * "paid" here never disagrees with the limits a customer is shown.
 */
export function entitledPlanCode(
  subscription: Pick<Subscription, 'planCode' | 'status'> | null | undefined,
): string {
  return subscription && subscription.status === 'active'
    ? subscription.planCode
    : FREE_PLAN_CODE;
}

/** May a NEW channel of this platform be connected on this (entitled) plan? */
export function isPlatformAllowedOnPlan(
  platform: string,
  planCode: string,
): boolean {
  return !isPaidOnlyPlatform(platform) || isPaidPlan(planCode);
}

/**
 * The 403 for "this needs a paid plan". The body keeps Nest's standard
 * `{ statusCode, error, message }` and adds a machine-readable `code` and the
 * `feature`, the shape of CHANNEL_LIMIT_REACHED, so the Channels page can open
 * the upgrade dialog instead of parsing the message. Through the OAuth
 * callback redirect the code arrives as `&code=PLAN_UPGRADE_REQUIRED`.
 */
export function planUpgradeRequired(
  platform: SupportedPlatform,
): ForbiddenException {
  const feature = PAID_ONLY_FEATURE[platform] ?? platform;
  const label = PAID_ONLY_LABEL[platform] ?? platform;
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: PLAN_UPGRADE_REQUIRED,
    feature,
    message: `${label} is available on paid plans.`,
  });
}
