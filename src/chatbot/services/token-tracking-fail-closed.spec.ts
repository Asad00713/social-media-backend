import { TokenTrackingService } from './token-tracking.service';

/**
 * `checkBudget` and `getUsageSummary` both used to treat a zero limit — and a
 * missing usage row — as UNLIMITED, returning `exceeded: false`. That made
 * Maestro and the chatbot free and uncapped for any such workspace, which is
 * the most expensive thing here to give away: one Maestro message runs up to
 * 8 API calls at 16,000 max_tokens.
 *
 * It also disagreed with `AiTokenService.checkTokens`, which has always
 * refused on `plan.aiTokensPerMonth === 0`. Two meters, same situation,
 * opposite answers, and the permissive one guarded the costlier feature.
 *
 * These tests pin the fail-closed direction. There were no tests on this file
 * before, which is why the behaviour survived.
 */

type UsageRow = {
  aiTokensLimit: number;
  extraAiTokensPurchased: number;
  aiTokensUsedThisMonth: number;
  aiTokensResetDate: Date | null;
};

function serviceWith(row: UsageRow | undefined) {
  const db = {
    query: {
      workspaceUsage: { findFirst: jest.fn().mockResolvedValue(row) },
    },
  };
  return new TokenTrackingService(db as never);
}

const WS = 'workspace-1';

describe('TokenTrackingService fails closed', () => {
  describe('checkBudget', () => {
    it('refuses a workspace with no usage row', async () => {
      const status = await serviceWith(undefined).checkBudget(WS);
      expect(status.exceeded).toBe(true);
      expect(status.limit).toBe(0);
      expect(status.remaining).toBe(0);
    });

    it('refuses a zero limit rather than treating it as unlimited', async () => {
      const status = await serviceWith({
        aiTokensLimit: 0,
        extraAiTokensPurchased: 0,
        aiTokensUsedThisMonth: 0,
        aiTokensResetDate: null,
      }).checkBudget(WS);

      // The old code returned false here: `totalLimit > 0 && ...` short-
      // circuited, so nothing was ever over budget on a zero limit.
      expect(status.exceeded).toBe(true);
    });

    it('allows a workspace with budget left', async () => {
      const status = await serviceWith({
        aiTokensLimit: 10000,
        extraAiTokensPurchased: 0,
        aiTokensUsedThisMonth: 4000,
        aiTokensResetDate: null,
      }).checkBudget(WS);

      expect(status.exceeded).toBe(false);
      expect(status.remaining).toBe(6000);
    });

    it('refuses once usage reaches the limit', async () => {
      const status = await serviceWith({
        aiTokensLimit: 10000,
        extraAiTokensPurchased: 0,
        aiTokensUsedThisMonth: 10000,
        aiTokensResetDate: null,
      }).checkBudget(WS);

      expect(status.exceeded).toBe(true);
      expect(status.remaining).toBe(0);
    });

    it('counts purchased add-on tokens toward the ceiling', async () => {
      const status = await serviceWith({
        aiTokensLimit: 10000,
        extraAiTokensPurchased: 5000,
        aiTokensUsedThisMonth: 12000,
        aiTokensResetDate: null,
      }).checkBudget(WS);

      // A top-up must actually buy capacity, not just raise a display number.
      expect(status.exceeded).toBe(false);
      expect(status.limit).toBe(15000);
      expect(status.remaining).toBe(3000);
    });

    it('refuses a zero base limit even when nothing was purchased', async () => {
      const status = await serviceWith({
        aiTokensLimit: 0,
        extraAiTokensPurchased: 0,
        aiTokensUsedThisMonth: 50,
        aiTokensResetDate: null,
      }).checkBudget(WS);

      expect(status.exceeded).toBe(true);
    });
  });

  describe('getUsageSummary agrees with checkBudget', () => {
    // The UI meter reads getUsageSummary while the send path reads
    // checkBudget. If they disagree, the owner is told they have budget and
    // then refused (or the reverse).
    const cases: ReadonlyArray<{ name: string; row: UsageRow | undefined }> = [
      { name: 'no usage row', row: undefined },
      {
        name: 'zero limit',
        row: {
          aiTokensLimit: 0,
          extraAiTokensPurchased: 0,
          aiTokensUsedThisMonth: 0,
          aiTokensResetDate: null,
        },
      },
      {
        name: 'budget remaining',
        row: {
          aiTokensLimit: 10000,
          extraAiTokensPurchased: 0,
          aiTokensUsedThisMonth: 1,
          aiTokensResetDate: null,
        },
      },
      {
        name: 'exhausted',
        row: {
          aiTokensLimit: 10000,
          extraAiTokensPurchased: 0,
          aiTokensUsedThisMonth: 10000,
          aiTokensResetDate: null,
        },
      },
      {
        name: 'exhausted but topped up',
        row: {
          aiTokensLimit: 10000,
          extraAiTokensPurchased: 2000,
          aiTokensUsedThisMonth: 10500,
          aiTokensResetDate: null,
        },
      },
    ];

    it.each(cases)('$name', async ({ row }) => {
      const budget = await serviceWith(row).checkBudget(WS);
      const summary = await serviceWith(row).getUsageSummary(WS);
      expect(summary.exceeded).toBe(budget.exceeded);
      expect(summary.limit).toBe(budget.limit);
      expect(summary.remaining).toBe(budget.remaining);
    });
  });
});
