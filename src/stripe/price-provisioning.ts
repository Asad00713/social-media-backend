import type Stripe from 'stripe';

/** Stable Stripe lookup_key for a plan's monthly price. */
export function planLookupKey(planCode: string): string {
  return `plan_${planCode.toLowerCase()}_monthly`;
}

/** Stable Stripe lookup_key for an addon price (per plan + type). */
export function addonLookupKey(planCode: string, addonType: string): string {
  return `addon_${addonType.toLowerCase()}_${planCode.toLowerCase()}`;
}

const ADDON_DISPLAY_NAMES: Record<string, string> = {
  EXTRA_CHANNEL: 'Extra Channel',
  EXTRA_MEMBER: 'Extra Team Member',
  EXTRA_WORKSPACE: 'Extra Workspace',
  AI_TOKENS: 'AI Tokens',
};

/** Human-readable product name for an addon. */
export function addonDisplayName(addonType: string, planCode: string): string {
  return `${ADDON_DISPLAY_NAMES[addonType] || addonType} (${planCode})`;
}
