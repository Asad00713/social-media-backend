import {
  YOUTUBE_INBOX_TIERS,
  pickYoutubeInboxTier,
  isDueForPoll,
} from './youtube-inbox-tier.util';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('pickYoutubeInboxTier', () => {
  it('classifies a brand-new video as hot', () => {
    expect(pickYoutubeInboxTier(0).name).toBe('hot');
  });

  // Boundaries are where off-by-one tier bugs live: a video one millisecond
  // before 48h must still be hot, and at exactly 48h must be warm.
  it('is hot just under 48h and warm at exactly 48h', () => {
    expect(pickYoutubeInboxTier(2 * DAY - 1).name).toBe('hot');
    expect(pickYoutubeInboxTier(2 * DAY).name).toBe('warm');
  });

  it('is warm just under 7d and cool at exactly 7d', () => {
    expect(pickYoutubeInboxTier(7 * DAY - 1).name).toBe('warm');
    expect(pickYoutubeInboxTier(7 * DAY).name).toBe('cool');
  });

  it('is cool just under 30d and cold at exactly 30d', () => {
    expect(pickYoutubeInboxTier(30 * DAY - 1).name).toBe('cool');
    expect(pickYoutubeInboxTier(30 * DAY).name).toBe('cold');
  });

  it('gives each tier the interval the spec requires', () => {
    const byName = Object.fromEntries(
      YOUTUBE_INBOX_TIERS.map((t) => [t.name, t.intervalMs]),
    );
    expect(byName.hot).toBe(15 * MIN);
    expect(byName.warm).toBe(1 * HOUR);
    expect(byName.cool).toBe(6 * HOUR);
    expect(byName.cold).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isDueForPoll', () => {
  const hot = pickYoutubeInboxTier(0);
  const cold = pickYoutubeInboxTier(60 * DAY);
  const now = 1_000 * DAY;

  it('polls a never-polled video immediately', () => {
    expect(isDueForPoll(hot, null, now)).toBe(true);
  });

  it('does not poll again before the interval has elapsed', () => {
    expect(isDueForPoll(hot, now - (15 * MIN - 1), now)).toBe(false);
  });

  it('polls again once the interval has elapsed', () => {
    expect(isDueForPoll(hot, now - 15 * MIN, now)).toBe(true);
  });

  // Cold is "never", including the never-polled case — an infinite interval
  // must not be short-circuited by the null-lastPolled branch.
  it('never polls a cold video, even one never polled before', () => {
    expect(isDueForPoll(cold, null, now)).toBe(false);
    expect(isDueForPoll(cold, 0, now)).toBe(false);
  });
});
