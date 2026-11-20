import { AI_OPERATION_COSTS } from './ai-token.service';

/**
 * A credit must be worth roughly the same amount of money whichever operation
 * spends it. When it isn't, the cheap-looking operation is a hole in the
 * pricing: `generate_alt_text` sat at 2 credits while costing ~$0.0121 a call,
 * about 112x what 2 credits are worth, so a Basic workspace could spend its
 * $5 allowance and cost us $33.
 *
 * This suite is the net under that. It does not re-derive prices — it pins the
 * two facts that made the hole possible, so the next operation that sends an
 * image, or picks a bigger model, cannot quietly land in a cheap tier.
 */

/** Haiku 5.5 at $0.10/$0.50 per MTok: ~$0.000054 per credit (2026-11-20). */
const DOLLARS_PER_CREDIT = 0.000054;

/**
 * Operations whose provider does NOT bill like Haiku text, with the measured
 * worst case per call. These are the ones that can hide a hole: their cost is
 * driven by an image's pixel count or an audio clip's length, so it does not
 * move with the credit price the text tiers were built around.
 */
const METERED_OPERATIONS: ReadonlyArray<{
  operation: string;
  worstCaseDollars: number;
  why: string;
}> = [
  {
    operation: 'generate_alt_text',
    worstCaseDollars: 0.0121,
    why: 'Sonnet 5.5 vision, ~1,400-token image, 2048 max_tokens',
  },
  {
    operation: 'speech_to_text',
    worstCaseDollars: 0.01,
    why: 'ElevenLabs Scribe at $0.20/hour, capped at 180s by the service',
  },
];

describe('AI_OPERATION_COSTS pricing floor', () => {
  it.each(METERED_OPERATIONS)(
    '$operation charges enough credits to cover what it costs us',
    ({ operation, worstCaseDollars }) => {
      const credits = AI_OPERATION_COSTS[operation];
      expect(credits).toBeDefined();

      // Allow a 25% margin: token counts move with image shape and the
      // model's thinking, and this is a floor, not a tariff.
      const minimum = Math.floor((worstCaseDollars / DOLLARS_PER_CREDIT) * 0.75);
      expect(credits).toBeGreaterThanOrEqual(minimum);
    },
  );

  it('no metered-provider operation sits in a text-priced tier', () => {
    // Every text operation today is <= 15 credits. One of these in that range
    // is the exact mistake this suite exists for: it reads as "cheap" next to
    // its neighbours while costing one to two orders of magnitude more.
    const TEXT_TIER_CEILING = 15;
    for (const { operation } of METERED_OPERATIONS) {
      expect(AI_OPERATION_COSTS[operation]).toBeGreaterThan(TEXT_TIER_CEILING);
    }
  });

  it('the Free pool cannot buy a metered-provider call', () => {
    // 100 credits is sized for the first-week onboarding (brand_learn + 5
    // drafts = 33), not for a vision or audio call. Asserting this keeps the
    // relationship deliberate: if a later change makes one of these affordable
    // on Free, that is a pricing decision and this line should fail and be
    // re-argued, not slip through.
    const FREE_POOL = 100;
    for (const { operation } of METERED_OPERATIONS) {
      expect(AI_OPERATION_COSTS[operation]).toBeGreaterThan(FREE_POOL);
    }
  });

  it('every text operation stays near the per-credit cost it was priced at', () => {
    // Guards the other direction: an operation whose credits are raised far
    // above its cost is overcharging users. Text operations run on Haiku and
    // should stay inside the tiers they were designed around.
    const textOperations = Object.entries(AI_OPERATION_COSTS).filter(
      ([operation]) =>
        !METERED_OPERATIONS.some((v) => v.operation === operation),
    );

    expect(textOperations.length).toBeGreaterThan(10);
    for (const [, credits] of textOperations) {
      expect(credits).toBeGreaterThanOrEqual(2);
      expect(credits).toBeLessThanOrEqual(15);
    }
  });
});
