import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { refreshAudience, type RefreshDeps } from './refresh';

const igBody = (dim: string, value: number) => ({
  data: [
    {
      total_value: {
        breakdowns: [{ results: [{ dimension_values: [dim], value }] }],
      },
    },
  ],
});

const fbBody = (map: Record<string, number>) => ({
  data: [{ values: [{ end_time: '2026-11-10T08:00:00+0000', value: map }] }],
});

function deps(overrides: Partial<Record<keyof RefreshDeps, unknown>> = {}) {
  const ig = jest.fn((_id: string, _t: string, b: string) => {
    if (b === 'country') return Promise.resolve(igBody('PK', 300));
    if (b === 'city') return Promise.resolve(igBody('Karachi, Sindh', 120));
    if (b === 'age') return Promise.resolve(igBody('25-34', 200));
    return Promise.resolve(igBody('F', 250));
  });
  const th = jest.fn((_t: string, b: string) =>
    Promise.resolve(b === 'country' ? igBody('US', 10) : igBody('x', 1)),
  );
  const fb = jest.fn((_p: string, _t: string, m: string) =>
    Promise.resolve(
      m === 'page_follows_country'
        ? fbBody({ PK: 40 })
        : fbBody({ 'Lahore, Punjab': 9 }),
    ),
  );
  const d = {
    instagram: { getFollowerDemographics: ig },
    threads: { getFollowerDemographics: th },
    facebook: { getPageFollowsLocation: fb },
    ...overrides,
  } as RefreshDeps;
  return { d, ig, th, fb };
}

const channel = (
  platform: SupportedPlatform,
  followersCount: number | null,
) => ({
  platform,
  platformAccountId: 'acct-1',
  accessToken: 'tok',
  followersCount,
});

describe('refreshAudience', () => {
  it('Instagram under 100 followers is below_threshold with no call', async () => {
    const { d, ig } = deps();
    const row = await refreshAudience(channel('instagram', 99), d);
    expect(row).toEqual({
      status: 'below_threshold',
      followerCount: 99,
      countries: [],
      cities: [],
      ages: [],
      genders: [],
    });
    expect(ig).not.toHaveBeenCalled();
  });

  it('Instagram with an unknown follower count is below_threshold', async () => {
    const { d, ig } = deps();
    const row = await refreshAudience(channel('instagram', null), d);
    expect(row.status).toBe('below_threshold');
    expect(row.followerCount).toBeNull();
    expect(ig).not.toHaveBeenCalled();
  });

  it('Threads under 100 followers is below_threshold with no call', async () => {
    const { d, th } = deps();
    const row = await refreshAudience(channel('threads', 99), d);
    expect(row.status).toBe('below_threshold');
    expect(th).not.toHaveBeenCalled();
  });

  it('Instagram with exactly 100 followers fetches', async () => {
    const { d, ig } = deps();
    const row = await refreshAudience(channel('instagram', 100), d);
    expect(row.status).toBe('ok');
    expect(ig).toHaveBeenCalledTimes(4);
  });

  it('Instagram with 500 followers makes 4 calls and stores raw slices', async () => {
    const { d, ig } = deps();
    const row = await refreshAudience(channel('instagram', 500), d);
    expect(ig).toHaveBeenCalledTimes(4);
    expect(ig.mock.calls.map((c) => c[2]).sort()).toEqual([
      'age',
      'city',
      'country',
      'gender',
    ]);
    expect(ig).toHaveBeenCalledWith('acct-1', 'tok', 'country');
    expect(row).toEqual({
      status: 'ok',
      followerCount: 500,
      countries: [{ key: 'PK', value: 300 }],
      cities: [{ key: 'Karachi', value: 120 }],
      ages: [{ key: '25-34', value: 200 }],
      genders: [{ key: 'female', value: 250 }],
    });
  });

  it('Threads with enough followers makes 4 calls with only the token', async () => {
    const { d, th } = deps();
    const row = await refreshAudience(channel('threads', 1000), d);
    expect(th).toHaveBeenCalledTimes(4);
    expect(th).toHaveBeenCalledWith('tok', 'country');
    expect(row.status).toBe('ok');
    expect(row.countries).toEqual([{ key: 'US', value: 10 }]);
  });

  it('Facebook makes 2 calls with ages and genders empty, and has no follower threshold', async () => {
    const { d, fb } = deps();
    const row = await refreshAudience(channel('facebook', 3), d);
    expect(fb).toHaveBeenCalledTimes(2);
    expect(fb).toHaveBeenCalledWith('acct-1', 'tok', 'page_follows_country');
    expect(fb).toHaveBeenCalledWith('acct-1', 'tok', 'page_follows_city');
    expect(row.status).toBe('ok');
    expect(row.followerCount).toBe(3);
    expect(row.countries).toEqual([{ key: 'PK', value: 40 }]);
    expect(row.cities).toEqual([{ key: 'Lahore', value: 9 }]);
    expect(row.ages).toEqual([]);
    expect(row.genders).toEqual([]);
  });

  it('TikTok is unsupported and calls nothing', async () => {
    const { d, ig, th, fb } = deps();
    const row = await refreshAudience(channel('tiktok', 5000), d);
    expect(row).toEqual({
      status: 'unsupported',
      followerCount: 5000,
      countries: [],
      cities: [],
      ages: [],
      genders: [],
    });
    expect(ig).not.toHaveBeenCalled();
    expect(th).not.toHaveBeenCalled();
    expect(fb).not.toHaveBeenCalled();
  });

  it('one Instagram call throwing metaCode 10 makes the whole row no_permission', async () => {
    const { d } = deps({
      instagram: {
        getFollowerDemographics: jest.fn(
          (_i: string, _t: string, b: string) => {
            if (b === 'city') {
              return Promise.reject(
                Object.assign(new Error('perm'), { metaCode: 10 }),
              );
            }
            return Promise.resolve(igBody('PK', 5));
          },
        ),
      },
    });
    const row = await refreshAudience(channel('instagram', 500), d);
    expect(row).toEqual({
      status: 'no_permission',
      followerCount: 500,
      countries: [],
      cities: [],
      ages: [],
      genders: [],
    });
  });

  it.each(['permanent', 'auth_failed', 'not_found'])(
    'a %s error is failed and not rethrown',
    async (code) => {
      const { d } = deps({
        facebook: {
          getPageFollowsLocation: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error('nope'), { code })),
        },
      });
      const row = await refreshAudience(channel('facebook', 900), d);
      expect(row.status).toBe('failed');
      expect(row.countries).toEqual([]);
    },
  );

  it('an error with no code is failed and not rethrown', async () => {
    const { d } = deps({
      facebook: {
        getPageFollowsLocation: jest
          .fn()
          .mockRejectedValue(new Error('network down')),
      },
    });
    const row = await refreshAudience(channel('facebook', 900), d);
    expect(row.status).toBe('failed');
  });

  it.each(['transient', 'rate_limited'])(
    'a %s error is rethrown, so a good stored row is never overwritten',
    async (code) => {
      const err = Object.assign(new Error('try later'), { code });
      const { d } = deps({
        instagram: {
          getFollowerDemographics: jest.fn(
            (_i: string, _t: string, b: string) =>
              b === 'age'
                ? Promise.reject(err)
                : Promise.resolve(igBody('PK', 5)),
          ),
        },
      });
      await expect(refreshAudience(channel('instagram', 500), d)).rejects.toBe(
        err,
      );
    },
  );

  it('a 200 with an empty data array is ok with empty arrays', async () => {
    const { d } = deps({
      instagram: {
        getFollowerDemographics: jest.fn(() => Promise.resolve({ data: [] })),
      },
    });
    const row = await refreshAudience(channel('instagram', 500), d);
    expect(row.status).toBe('ok');
    expect(row.countries).toEqual([]);
    expect(row.genders).toEqual([]);
  });
});
