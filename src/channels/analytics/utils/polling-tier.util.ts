export interface PollingTier {
  name: string;
  maxAgeMs: number;
  intervalMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const POST_POLLING_TIERS: PollingTier[] = [
  { name: 'fresh',  maxAgeMs:  1 * HOUR, intervalMs:  5 * MIN },
  { name: 'hot',    maxAgeMs:  6 * HOUR, intervalMs: 15 * MIN },
  { name: 'recent', maxAgeMs: 24 * HOUR, intervalMs: 30 * MIN },
  { name: 'week',   maxAgeMs:  7 * DAY,  intervalMs:  2 * HOUR },
  { name: 'month',  maxAgeMs: 30 * DAY,  intervalMs:  6 * HOUR },
  { name: 'cold',   maxAgeMs: Number.POSITIVE_INFINITY, intervalMs: 24 * HOUR },
];

export const CHANNEL_PROFILE_TIERS: PollingTier[] = [
  { name: 'new',    maxAgeMs: 24 * HOUR, intervalMs:  5 * MIN },
  { name: 'active', maxAgeMs:  7 * DAY,  intervalMs: 15 * MIN },
  { name: 'normal', maxAgeMs: Number.POSITIVE_INFINITY, intervalMs: 30 * MIN },
];

/** Pick the tier whose maxAgeMs is the smallest one that exceeds the given age. */
export function pickTier(tiers: PollingTier[], ageMs: number): PollingTier {
  for (const tier of tiers) {
    if (ageMs < tier.maxAgeMs) return tier;
  }
  return tiers[tiers.length - 1];
}

/** Maps post age to the matching ageBucket label used by snapshot rows. */
export function tierToAgeBucket(tier: PollingTier): '30m' | '1h' | '6h' | '24h' | '3d' | '7d' | '30d' | 'final' {
  switch (tier.name) {
    case 'fresh':  return '1h';
    case 'hot':    return '6h';
    case 'recent': return '24h';
    case 'week':   return '7d';
    case 'month':  return '30d';
    case 'cold':   return 'final';
    default:       return 'final';
  }
}
