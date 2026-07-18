import { InboxPollProcessor } from './inbox-poll.processor';

/**
 * The processor reaches the DB via a module-level `db` singleton, so this
 * suite exercises the one piece that is unit-testable in isolation and is
 * also the piece this task adds: the YouTube branch that narrows the
 * candidate post list to the budget service's `due` set.
 */
describe('InboxPollProcessor.selectYoutubeTargets', () => {
  const budget = {
    selectDue: jest.fn(),
    markPolled: jest.fn(),
  };

  function build() {
    return new InboxPollProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      budget as any,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  const posts = [
    { platformPostId: 'vidA', publishedAt: new Date('2026-07-18T00:00:00Z') },
    { platformPostId: 'vidB', publishedAt: new Date('2026-06-01T00:00:00Z') },
  ];

  it('returns only the videos the budget service allows', async () => {
    budget.selectDue.mockResolvedValue({
      due: [{ videoId: 'vidA', publishedAtMs: 0 }],
      deferred: 1,
      deferredByTier: { cool: 1 },
    });

    const allowed = await (build() as any).selectYoutubeTargets(7, posts);

    expect(allowed).toEqual(new Set(['vidA']));
    expect(budget.selectDue).toHaveBeenCalledWith(
      7,
      [
        { videoId: 'vidA', publishedAtMs: posts[0].publishedAt.getTime() },
        { videoId: 'vidB', publishedAtMs: posts[1].publishedAt.getTime() },
      ],
      expect.any(Number),
    );
  });

  it('allows nothing when the budget service returns nothing', async () => {
    budget.selectDue.mockResolvedValue({
      due: [],
      deferred: 2,
      deferredByTier: { hot: 2 },
    });

    const allowed = await (build() as any).selectYoutubeTargets(7, posts);

    expect(allowed.size).toBe(0);
  });

  // A post with no publishedAt has no age, so it cannot be tiered. Treat it
  // as brand new rather than dropping it — dropping would silently stop
  // polling a video forever.
  it('treats a post with no publishedAt as newly published', async () => {
    budget.selectDue.mockResolvedValue({
      due: [],
      deferred: 0,
      deferredByTier: {},
    });
    const now = Date.now();

    await (build() as any).selectYoutubeTargets(7, [
      { platformPostId: 'vidC', publishedAt: null },
    ]);

    const [, candidates] = budget.selectDue.mock.calls[0];
    expect(candidates[0].publishedAtMs).toBeGreaterThanOrEqual(now);
  });
});
