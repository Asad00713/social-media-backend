import {
  facebookLocation,
  metaBreakdown,
  statusOfError,
  toShares,
  youtubeAges,
  youtubeGenders,
} from './normalize';

/**
 * Shape per Meta's Instagram `follower_demographics` insights:
 * data[0].total_value.breakdowns[0].results[].{dimension_values, value}.
 */
function igBody(
  breakdown: string,
  results: Array<[string, number]>,
): Record<string, unknown> {
  return {
    data: [
      {
        name: 'follower_demographics',
        period: 'lifetime',
        title: 'Follower demographics',
        total_value: {
          breakdowns: [
            {
              dimension_keys: [breakdown],
              results: results.map(([dim, value]) => ({
                dimension_values: [dim],
                value,
              })),
            },
          ],
        },
        id: '17841400000000000/insights/follower_demographics/lifetime',
      },
    ],
  };
}

describe('metaBreakdown', () => {
  it('maps a country body to raw slices', () => {
    const body = igBody('country', [
      ['PK', 120],
      ['US', 30],
    ]);
    expect(metaBreakdown(body, 'country')).toEqual([
      { key: 'PK', value: 120 },
      { key: 'US', value: 30 },
    ]);
  });

  it('keeps only the text before the first comma for cities and sums duplicates', () => {
    const body = igBody('city', [
      ['Karachi, Sindh', 50],
      ['Lahore, Punjab', 20],
      ['Karachi, Texas', 5],
    ]);
    expect(metaBreakdown(body, 'city')).toEqual([
      { key: 'Karachi', value: 55 },
      { key: 'Lahore', value: 20 },
    ]);
  });

  it('merges 55-64 and 65+ into 55+ and drops unknown age keys', () => {
    const body = igBody('age', [
      ['13-17', 1],
      ['25-34', 10],
      ['55-64', 3],
      ['65+', 2],
      ['0-1', 99],
    ]);
    expect(metaBreakdown(body, 'age')).toEqual([
      { key: '13-17', value: 1 },
      { key: '25-34', value: 10 },
      { key: '55+', value: 5 },
    ]);
  });

  it('maps F/M/U to female/male/unknown', () => {
    const body = igBody('gender', [
      ['F', 60],
      ['M', 30],
      ['U', 10],
    ]);
    expect(metaBreakdown(body, 'gender')).toEqual([
      { key: 'female', value: 60 },
      { key: 'male', value: 30 },
      { key: 'unknown', value: 10 },
    ]);
  });

  it.each([
    ['empty data', { data: [] }],
    ['no data key', {}],
    ['null', null],
    ['a string', 'nope'],
    ['no total_value', { data: [{ name: 'follower_demographics' }] }],
    ['empty breakdowns', { data: [{ total_value: { breakdowns: [] } }] }],
    [
      'no results',
      { data: [{ total_value: { breakdowns: [{ dimension_keys: ['x'] }] } }] },
    ],
  ])('returns [] for %s without throwing', (_label, body) => {
    expect(metaBreakdown(body, 'country')).toEqual([]);
  });

  it('skips malformed result rows', () => {
    const body = {
      data: [
        {
          total_value: {
            breakdowns: [
              {
                results: [
                  { dimension_values: [], value: 4 },
                  { dimension_values: ['PK'], value: 'x' },
                  { dimension_values: ['US'], value: 7 },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(metaBreakdown(body, 'country')).toEqual([{ key: 'US', value: 7 }]);
  });
});

describe('facebookLocation', () => {
  it('takes the newest values entry', () => {
    const body = {
      data: [
        {
          name: 'page_follows_country',
          values: [
            { value: { US: 1 }, end_time: '2026-11-08T08:00:00+0000' },
            { value: { PK: 9, US: 3 }, end_time: '2026-11-10T08:00:00+0000' },
            { value: { IN: 2 }, end_time: '2026-11-09T08:00:00+0000' },
          ],
        },
      ],
    };
    expect(facebookLocation(body)).toEqual([
      { key: 'PK', value: 9 },
      { key: 'US', value: 3 },
    ]);
  });

  it.each([
    ['empty data', { data: [] }],
    ['empty values', { data: [{ values: [] }] }],
    ['null', null],
    ['value not an object', { data: [{ values: [{ value: 5 }] }] }],
  ])('returns [] for %s', (_label, body) => {
    expect(facebookLocation(body)).toEqual([]);
  });
});

describe('youtube demographics', () => {
  const rows = [
    { ageGroup: 'age13-17', gender: 'female', viewerPercentage: 2.5 },
    { ageGroup: 'age13-17', gender: 'male', viewerPercentage: 1.5 },
    { ageGroup: 'age25-34', gender: 'male', viewerPercentage: 30 },
    { ageGroup: 'age55-64', gender: 'female', viewerPercentage: 4 },
    { ageGroup: 'age65-', gender: 'user_specified', viewerPercentage: 1 },
    { ageGroup: 'age99', gender: 'male', viewerPercentage: 50 },
  ];

  it('sums across gender into age buckets, merging 55-64 and 65-', () => {
    expect(youtubeAges(rows)).toEqual([
      { key: '13-17', value: 4 },
      { key: '25-34', value: 30 },
      { key: '55+', value: 5 },
    ]);
  });

  it('sums across age into genders', () => {
    expect(youtubeGenders(rows.slice(0, 5))).toEqual([
      { key: 'female', value: 6.5 },
      { key: 'male', value: 31.5 },
      { key: 'unknown', value: 1 },
    ]);
  });

  it('returns [] for no rows', () => {
    expect(youtubeAges([])).toEqual([]);
    expect(youtubeGenders([])).toEqual([]);
  });
});

describe('toShares', () => {
  it('keeps the top 5 countries with percent of ALL slices', () => {
    const raw = [
      { key: 'A', value: 50 },
      { key: 'B', value: 20 },
      { key: 'C', value: 10 },
      { key: 'D', value: 8 },
      { key: 'E', value: 6 },
      { key: 'F', value: 4 },
      { key: 'G', value: 2 },
    ];
    expect(toShares(raw, 'countries')).toEqual([
      { key: 'A', percent: 50 },
      { key: 'B', percent: 20 },
      { key: 'C', percent: 10 },
      { key: 'D', percent: 8 },
      { key: 'E', percent: 6 },
    ]);
  });

  it('keeps the top 4 cities', () => {
    const raw = [
      { key: 'a', value: 1 },
      { key: 'b', value: 4 },
      { key: 'c', value: 3 },
      { key: 'd', value: 2 },
      { key: 'e', value: 10 },
    ];
    const out = toShares(raw, 'cities');
    expect(out.map((s) => s.key)).toEqual(['e', 'b', 'c', 'd']);
    expect(out.map((s) => s.percent)).toEqual([50, 20, 15, 10]);
  });

  it('rounds to one decimal', () => {
    const out = toShares(
      [
        { key: 'A', value: 1 },
        { key: 'B', value: 2 },
      ],
      'countries',
    );
    expect(out).toEqual([
      { key: 'B', percent: 66.7 },
      { key: 'A', percent: 33.3 },
    ]);
  });

  it('gives 6 fixed age buckets with a missing bucket at 0', () => {
    const out = toShares(
      [
        { key: '55-64', value: 3 },
        { key: '65+', value: 1 },
        { key: '25-34', value: 6 },
      ],
      'ages',
    );
    expect(out).toEqual([
      { key: '13-17', percent: 0 },
      { key: '18-24', percent: 0 },
      { key: '25-34', percent: 60 },
      { key: '35-44', percent: 0 },
      { key: '45-54', percent: 0 },
      { key: '55+', percent: 40 },
    ]);
  });

  it('gives genders in female, male, unknown order', () => {
    const out = toShares(
      [
        { key: 'unknown', value: 1 },
        { key: 'male', value: 3 },
      ],
      'genders',
    );
    expect(out).toEqual([
      { key: 'female', percent: 0 },
      { key: 'male', percent: 75 },
      { key: 'unknown', percent: 25 },
    ]);
  });

  it('does not re-normalise already-percent values, only rounds', () => {
    const out = toShares(
      [
        { key: 'female', value: 6.54 },
        { key: 'male', value: 31.46 },
        { key: 'unknown', value: 1 },
      ],
      'genders',
      true,
    );
    expect(out).toEqual([
      { key: 'female', percent: 6.5 },
      { key: 'male', percent: 31.5 },
      { key: 'unknown', percent: 1 },
    ]);
  });

  it('returns [] for empty input, for every kind', () => {
    for (const kind of ['countries', 'cities', 'ages', 'genders'] as const) {
      expect(toShares([], kind)).toEqual([]);
    }
  });

  it('gives 0 percent, not NaN, when every value is 0', () => {
    expect(toShares([{ key: 'PK', value: 0 }], 'countries')).toEqual([
      { key: 'PK', percent: 0 },
    ]);
  });
});

describe('statusOfError', () => {
  const withCode = (metaCode: unknown) =>
    Object.assign(new Error('x'), { metaCode });

  it.each([10, 200, 250, 299])('maps metaCode %i to no_permission', (code) => {
    expect(statusOfError(withCode(code))).toBe('no_permission');
  });

  it.each([190, 4, 17, 300, 100, 199])('maps metaCode %i to failed', (code) => {
    expect(statusOfError(withCode(code))).toBe('failed');
  });

  it('maps a non-numeric metaCode to failed', () => {
    expect(statusOfError(withCode('10'))).toBe('failed');
  });

  it('maps a plain Error and non-objects to failed', () => {
    expect(statusOfError(new Error('boom'))).toBe('failed');
    expect(statusOfError(undefined)).toBe('failed');
    expect(statusOfError(null)).toBe('failed');
    expect(statusOfError('str')).toBe('failed');
  });
});
