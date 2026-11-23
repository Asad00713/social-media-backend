/**
 * Which plan tier a feature needs — the plan-gating counterpart to
 * `role-capabilities.ts`.
 *
 * Deliberately the same shape as the role map, because it answers the same
 * kind of question and the project already reads that shape:
 *
 *   role    → `ROLE_RANK` + `CAPABILITY_MIN_ROLE` + `roleCan`
 *   plan    → `PLAN_RANK` + `FEATURE_MIN_PLAN`     + `planAllows`
 *
 * Pure: no DB, no NestJS, no imports. The guard and the controllers resolve a
 * plan code and ask this module; this module never looks anything up. That is
 * what makes the whole map testable without a database.
 *
 * ## Why this is not `plans.features`
 *
 * The `plans.features` JSONB column looks like the natural home and is not.
 * Nothing reads it as a gate — its only two readers are a billing API response
 * (`plan-change.service.ts`) and the comparison table — so it is marketing
 * copy, not enforcement. Worse, it is per-row data an operator can edit, which
 * means a typo silently grants a paid feature. The gate belongs in code,
 * reviewed and tested, with the column left to describe what the code does.
 *
 * ## Only booleans live here
 *
 * This map answers "may this tier use the feature at all". It deliberately
 * holds no numbers. A countable limit (3 folders, 30 days of history, 1 active
 * campaign) has to be checked where the count is known, against live rows, and
 * those already have homes: `plans` columns resolved by `limit-resolver.util`,
 * or a query's own bound. Putting a number here would create a second source
 * of truth for the same ceiling.
 */

/** Plan tiers, cheapest first. Mirrors `PlanChangeService.planHierarchy` and
 *  the frontend's `PLAN_HIERARCHY` (plan-helpers.ts). */
export type PlanCode = 'FREE' | 'BASIC' | 'PRO' | 'MAX' | 'ENTERPRISE';

export const PLAN_RANK: Record<PlanCode, number> = {
  FREE: 0,
  BASIC: 1,
  PRO: 2,
  MAX: 3,
  ENTERPRISE: 4,
};

/**
 * A capability a plan may or may not include.
 *
 * Named `<module>:<thing>` so the owning module is obvious at the call site.
 * Every entry here must be a feature that genuinely costs us money to run or
 * is genuinely an upmarket feature — not a thing made worse on purpose.
 */
export type PlanFeature =
  /**
   * Read and reply to comments and DMs.
   *
   * Paid at nearly every competitor (Later, Metricool and Planable all gate
   * it), and it is the single most expensive thing we poll: every connected
   * channel is swept on a schedule whether or not anyone reads the result.
   */
  | 'inbox:use'
  /** Generate a reply draft with AI. Charged in credits on top of this gate. */
  | 'inbox:ai-reply'
  /** Drip campaigns: AI generates content per platform, per slot. Real
   *  provider spend per post, on a schedule with no user waiting on it. */
  | 'campaigns:drip'
  /** Evergreen recycling: the rotation engine, an advanced-tier feature. */
  | 'campaigns:evergreen'
  /** Several channels inside ONE campaign. Free gets campaigns, but one
   *  channel at a time — a taste of the feature, not a crippled version. */
  | 'campaigns:multi-channel'
  /** Two-way Google / Outlook calendar sync. An outbound integration we
   *  maintain and refresh tokens for. */
  | 'calendar:sync'
  /** Export Insights as CSV or PDF. No competitor's entry tier has reports. */
  | 'insights:export'
  /** Scheduled Insights reports, which email people outside the workspace. */
  | 'insights:scheduled-reports'
  /** Maestro, the AI agent. One message can run eight model calls at 16k
   *  max_tokens: the most expensive thing we run per interaction. */
  | 'maestro:use'
  /** Ads / Boost: an agency feature, currently open to everyone. */
  | 'ads:use'
  /** Approval workflows (request + approve a draft). No competitor's entry
   *  tier has them. */
  | 'posts:approval-workflow'
  /** Workspace brand kit: colours, default logo, composer presets. */
  | 'brand:kit'
  /** Import a design from Canva. We re-host the export, so it costs bytes. */
  | 'library:canva-import';

/**
 * The cheapest plan that includes each feature.
 *
 * Source of truth: `schedura-landing/docs/plan-feature-matrix.md`, the matrix
 * agreed with the owner and handed to the marketing site. If a line changes
 * here it changes there too, or the site sells something the app refuses.
 */
export const FEATURE_MIN_PLAN: Record<PlanFeature, PlanCode> = {
  'inbox:use': 'BASIC',
  'inbox:ai-reply': 'BASIC',
  'campaigns:drip': 'BASIC',
  'campaigns:multi-channel': 'BASIC',
  'library:canva-import': 'BASIC',
  'campaigns:evergreen': 'PRO',
  'calendar:sync': 'PRO',
  'insights:export': 'PRO',
  'insights:scheduled-reports': 'PRO',
  'maestro:use': 'PRO',
  'ads:use': 'PRO',
  'posts:approval-workflow': 'PRO',
  'brand:kit': 'PRO',
};

/**
 * Normalise a plan code read from the database.
 *
 * An unrecognised code resolves to FREE — the LEAST generous answer — which is
 * the opposite of how `SubscriptionLookupService.getPlanLimits` treats a
 * missing plan row. That is deliberate and the two are not in conflict: there,
 * a missing row must not break a paying customer's publishing, so it falls
 * back to limits. Here, an unknown string must not hand out a paid feature.
 * The failure that matters is different in each direction.
 */
export function toPlanCode(code: string | null | undefined): PlanCode {
  const upper = (code ?? '').toUpperCase();
  return upper in PLAN_RANK ? (upper as PlanCode) : 'FREE';
}

/** Does this plan include this feature? */
export function planAllows(plan: PlanCode, feature: PlanFeature): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}

/** Every feature this plan includes — for the entitlements endpoint the
 *  frontend reads to draw locks, so the UI never hard-codes the map. */
export function featuresForPlan(plan: PlanCode): PlanFeature[] {
  return (Object.keys(FEATURE_MIN_PLAN) as PlanFeature[]).filter((f) =>
    planAllows(plan, f),
  );
}
