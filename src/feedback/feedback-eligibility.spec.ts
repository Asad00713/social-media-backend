import { promptFor, PromptInput } from './feedback-eligibility';

const NOW = new Date('2026-06-01T12:00:00Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    accountCreatedAt: daysAgo(400),
    latestReviewAt: null,
    latestDismissalAt: null,
    latestByType: { app: null, maestro: null },
    now: NOW,
    ...overrides,
  };
}

describe('promptFor', () => {
  describe('account age gate', () => {
    it('does not prompt an account younger than 30 days', () => {
      const result = promptFor(input({ accountCreatedAt: daysAgo(29) }));
      expect(result.prompt).toBeNull();
    });

    it('prompts once the account is 30 days old', () => {
      const result = promptFor(input({ accountCreatedAt: daysAgo(31) }));
      expect(result.prompt).toBe('app');
    });

    it('reports when a too-young account becomes eligible', () => {
      const result = promptFor(input({ accountCreatedAt: daysAgo(10) }));
      expect(result.nextEligibleAt).toEqual(
        new Date(daysAgo(10).getTime() + 30 * 24 * 60 * 60 * 1000),
      );
    });
  });

  describe('submit cooldown (90 days)', () => {
    it('does not prompt 89 days after a review', () => {
      expect(promptFor(input({ latestReviewAt: daysAgo(89) })).prompt).toBeNull();
    });

    it('prompts 91 days after a review', () => {
      expect(
        promptFor(input({ latestReviewAt: daysAgo(91) })).prompt,
      ).not.toBeNull();
    });
  });

  describe('dismiss cooldown (30 days)', () => {
    it('does not prompt 29 days after a dismissal', () => {
      expect(
        promptFor(input({ latestDismissalAt: daysAgo(29) })).prompt,
      ).toBeNull();
    });

    it('prompts 31 days after a dismissal', () => {
      expect(
        promptFor(input({ latestDismissalAt: daysAgo(31) })).prompt,
      ).not.toBeNull();
    });
  });

  describe('the throttle is GLOBAL, not per type', () => {
    // This is the rule most likely to regress: a per-type reading would
    // return 'maestro' here, prompting the user twice in ten days.
    it('does not offer maestro right after an app review', () => {
      const result = promptFor(
        input({
          latestReviewAt: daysAgo(10),
          latestByType: { app: daysAgo(10), maestro: null },
        }),
      );
      expect(result.prompt).toBeNull();
    });

    it('applies both cooldowns — the more restrictive one wins', () => {
      const result = promptFor(
        input({ latestDismissalAt: daysAgo(31), latestReviewAt: daysAgo(10) }),
      );
      expect(result.prompt).toBeNull();
    });
  });

  describe('which type is offered', () => {
    it('offers app first when neither has been rated', () => {
      expect(promptFor(input()).prompt).toBe('app');
    });

    it('offers the never-rated type over the rated one', () => {
      const result = promptFor(
        input({
          latestReviewAt: daysAgo(100),
          latestByType: { app: daysAgo(100), maestro: null },
        }),
      );
      expect(result.prompt).toBe('maestro');
    });

    it('offers the type whose last review is oldest', () => {
      const result = promptFor(
        input({
          latestReviewAt: daysAgo(100),
          latestByType: { app: daysAgo(300), maestro: daysAgo(100) },
        }),
      );
      expect(result.prompt).toBe('app');
    });
  });

  it('reports nextEligibleAt from the binding cooldown', () => {
    const reviewedAt = daysAgo(10);
    const result = promptFor(input({ latestReviewAt: reviewedAt }));
    expect(result.nextEligibleAt).toEqual(
      new Date(reviewedAt.getTime() + 90 * 24 * 60 * 60 * 1000),
    );
  });
});
