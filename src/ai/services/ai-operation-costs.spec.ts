import { AI_OPERATION_COSTS } from './ai-token.service';

describe('AI_OPERATION_COSTS (first week)', () => {
  it('charges 8 tokens to learn a brand', () => {
    expect(AI_OPERATION_COSTS.brand_learn).toBe(8);
  });

  it('charges 5 tokens per first-week draft', () => {
    expect(AI_OPERATION_COSTS.first_week_draft).toBe(5);
  });

  it('a whole first week costs 33 tokens, inside the 100-token Free pool', () => {
    const week =
      AI_OPERATION_COSTS.brand_learn + 5 * AI_OPERATION_COSTS.first_week_draft;
    expect(week).toBe(33);
    expect(week).toBeLessThanOrEqual(100);
  });
});
