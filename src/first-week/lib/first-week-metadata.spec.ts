import {
  carryFirstWeekMeta,
  FIRST_WEEK_SOURCE,
  firstWeekDraftId,
} from './first-week-metadata';

const WS = '11111111-1111-4111-8111-111111111111';
const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('firstWeekDraftId', () => {
  it('is a valid UUID', () => {
    expect(firstWeekDraftId(WS, 0)).toMatch(UUID_V5);
  });

  it('is deterministic per workspace and slot', () => {
    expect(firstWeekDraftId(WS, 2)).toBe(firstWeekDraftId(WS, 2));
  });

  it('differs across slots and across workspaces', () => {
    const ids = new Set([0, 1, 2, 3, 4].map((s) => firstWeekDraftId(WS, s)));
    expect(ids.size).toBe(5);
    expect(firstWeekDraftId(WS, 0)).not.toBe(
      firstWeekDraftId('22222222-2222-4222-8222-222222222222', 0),
    );
  });
});

describe('carryFirstWeekMeta', () => {
  it('carries the first-week keys forward', () => {
    expect(
      carryFirstWeekMeta({
        source: FIRST_WEEK_SOURCE,
        firstWeekSlot: 3,
        suggestedAt: '2026-10-19T13:00:00.000Z',
        imageCredit: {
          provider: 'unsplash',
          author: 'A',
          pageUrl: 'https://u',
        },
        hashtags: ['dropped'],
        title: 'dropped',
      }),
    ).toEqual({
      source: 'first_week',
      firstWeekSlot: 3,
      suggestedAt: '2026-10-19T13:00:00.000Z',
      imageCredit: { provider: 'unsplash', author: 'A', pageUrl: 'https://u' },
    });
  });

  it('returns nothing for any other post', () => {
    expect(carryFirstWeekMeta({ source: 'composer' })).toEqual({});
    expect(carryFirstWeekMeta({ syncedFrom: 'platform' })).toEqual({});
    expect(carryFirstWeekMeta(null)).toEqual({});
    expect(carryFirstWeekMeta(undefined)).toEqual({});
    expect(carryFirstWeekMeta('x')).toEqual({});
  });

  it('does not invent keys that were absent', () => {
    expect(carryFirstWeekMeta({ source: FIRST_WEEK_SOURCE })).toEqual({
      source: 'first_week',
    });
  });
});
