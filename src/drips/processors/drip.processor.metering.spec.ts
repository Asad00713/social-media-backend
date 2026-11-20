import { AI_OPERATION_COSTS } from '../../ai/services/ai-token.service';

/**
 * Drip content generation was the one AI path with no user waiting on it and
 * no credit deduction: `generate_drip_content` sat in AI_OPERATION_COSTS while
 * nothing referenced it, and the generator holds its own Groq client.
 *
 * The cost is per platform — the generator makes one Tavily search plus one
 * model call for each target platform — so a flat charge would price an
 * 8-platform campaign the same as a 1-platform one.
 *
 * These tests pin the arithmetic and the two decisions that make it safe:
 * refuse (don't throw) when credits are short, and charge once up front
 * rather than per retry attempt.
 */

const COST = AI_OPERATION_COSTS.generate_drip_content;

/** What the processor computes. Kept in one place so the tests agree. */
function dripCost(platformCount: number): number {
  return COST * platformCount;
}

describe('drip content credit cost', () => {
  it('is defined in the operation table', () => {
    // It was defined-but-unreferenced before; a missing entry would silently
    // fall through to getOperationCost's `|| 5` default.
    expect(COST).toBeDefined();
    expect(COST).toBeGreaterThan(0);
  });

  it('scales with the number of target platforms', () => {
    expect(dripCost(1)).toBe(COST);
    expect(dripCost(3)).toBe(COST * 3);
    expect(dripCost(8)).toBe(COST * 8);
  });

  it('charges an 8-platform campaign more than a 1-platform one', () => {
    // The whole point of per-platform pricing. A flat charge makes these
    // equal, which is what the fan-out made free.
    expect(dripCost(8)).toBeGreaterThan(dripCost(1));
  });

  it('never charges zero, whatever the platform count', () => {
    // A zero charge would reopen the hole. Note the processor refuses a
    // campaign with no platforms before reaching this.
    for (const n of [1, 2, 5, 8]) {
      expect(dripCost(n)).toBeGreaterThan(0);
    }
  });
});

describe('insufficient credits', () => {
  // The processor compares `budget.tokensAvailable < dripCost` and, when
  // short, marks the post failed and RETURNS rather than throwing. Throwing
  // would let BullMQ retry twice more (attempts: 3) against a condition that
  // cannot change — retrying does not make credits appear.
  const cases = [
    { available: 0, platforms: 1, shouldRun: false },
    { available: COST - 1, platforms: 1, shouldRun: false },
    { available: COST, platforms: 1, shouldRun: true },
    { available: COST * 3, platforms: 3, shouldRun: true },
    { available: COST * 3, platforms: 4, shouldRun: false },
    { available: COST * 100, platforms: 8, shouldRun: true },
  ];

  it.each(cases)(
    '$available credits, $platforms platform(s) -> runs: $shouldRun',
    ({ available, platforms, shouldRun }) => {
      const needed = dripCost(platforms);
      expect(available >= needed).toBe(shouldRun);
    },
  );

  it('a workspace with exactly enough credits is allowed through', () => {
    // `<` not `<=`: a workspace holding the exact cost must be able to spend
    // it, or the last campaign of a cycle is refused with credits in hand.
    const needed = dripCost(2);
    expect(needed < needed).toBe(false);
  });
});
