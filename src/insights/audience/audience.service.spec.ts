import { Logger } from '@nestjs/common';
import { channelAudience } from '../../drizzle/schema/channel-audience.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import type { SocialChannel } from '../insights-channels.repository';
import type { ResolvedPeriod } from '../lib/query';
import { customWindow } from '../../post-performance/period';
import { AudienceService, CACHE_READ_TIMEOUT_MS } from './audience.service';
import { latestFollowerCounts } from './latest-followers';

jest.mock('./latest-followers', () => ({ latestFollowerCounts: jest.fn() }));
jest.mock('../../common/utils/encryption.util', () => ({
  decrypt: (s: string) => `plain-${s}`,
}));

// The service logs a warning for every swallowed failure; keep the output clean.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const NOW = new Date('2026-10-20T12:00:00Z');
const period = (from: string, to: string): ResolvedPeriod => ({
  days: 7,
  window: customWindow(from, to),
});
const WEEK = period('2026-10-13', '2026-10-19');
const LONG = period('2026-07-22', '2026-10-19');

const channel = (
  id: number,
  platform: SupportedPlatform,
  isActive = true,
): SocialChannel => ({
  id,
  platform,
  accountName: `${platform}-${id}`,
  isActive,
  connectionStatus: 'connected',
});

interface Raw {
  key: string;
  value: number;
}
interface StoredRow {
  channelId: number;
  status: string;
  followerCount: number | null;
  countries: Raw[] | Record<string, never>;
  cities: Raw[];
  ages: Raw[];
  genders: Raw[];
  fetchedAt: Date;
}

interface SetupOptions {
  /** Channels whose token select returns no row. */
  noTokenFor?: number[];
  redisStatus?: string;
}

function setup(
  channels: SocialChannel[],
  rows: StoredRow[] = [],
  { noTokenFor = [], redisStatus = 'ready' }: SetupOptions = {},
) {
  const repo = {
    socialChannels: jest.fn().mockResolvedValue(channels),
    followerRows: jest.fn().mockResolvedValue([]),
  };
  // select().from(table).where() resolves to that table's rows.
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === channelAudience) return Promise.resolve(rows);
          if (table === socialMediaChannels) {
            return Promise.resolve(
              channels
                .filter((c) => !noTokenFor.includes(c.id))
                .map((c) => ({ id: c.id, accessToken: `tok-${c.id}` })),
            );
          }
          return Promise.resolve([]);
        },
      }),
    }),
  };
  const youtube = {
    getDemographics: jest.fn().mockResolvedValue([
      { ageGroup: 'age18-24', gender: 'female', viewerPercentage: 30 },
      { ageGroup: 'age18-24', gender: 'male', viewerPercentage: 20 },
      { ageGroup: 'age25-34', gender: 'male', viewerPercentage: 50 },
    ]),
    getViewsByCountry: jest.fn().mockResolvedValue([
      { key: 'US', value: 75 },
      { key: 'PK', value: 25 },
    ]),
  };
  const store = new Map<string, string>();
  const redis = {
    status: redisStatus,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  (latestFollowerCounts as jest.Mock).mockImplementation(
    (_db: unknown, ids: number[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, 1000 + id]))),
  );
  const service = new AudienceService(
    repo as never,
    db as never,
    youtube as never,
    redis as never,
    queue as never,
  );
  return { service, repo, youtube, redis, queue };
}

const HOUR = 3_600_000;

const stored = (
  channelId: number,
  ageMs: number,
  extra: Partial<StoredRow> = {},
): StoredRow => ({
  channelId,
  status: 'ok',
  followerCount: 500,
  countries: [
    { key: 'US', value: 30 },
    { key: 'PK', value: 10 },
  ],
  cities: [{ key: 'Karachi', value: 5 }],
  ages: [{ key: '18-24', value: 1 }],
  genders: [{ key: 'F', value: 1 }],
  fetchedAt: new Date(NOW.getTime() - ageMs),
  ...extra,
});

describe('AudienceService.growth', () => {
  it('leaves LinkedIn out and asks for the day after the window ends', async () => {
    const { service, repo } = setup([
      channel(1, 'instagram'),
      channel(2, 'linkedin'),
      channel(3, 'reddit'),
    ]);
    const dto = await service.growth('ws', WEEK, undefined);
    expect(repo.followerRows).toHaveBeenCalledWith(
      [1],
      '2026-10-13',
      '2026-10-20',
    );
    expect(dto.channels.map((c) => c.channelId)).toEqual([1]);
  });

  it('applies the channel filter', async () => {
    const { service, repo } = setup([
      channel(1, 'instagram'),
      channel(2, 'twitter'),
      channel(3, 'bluesky'),
    ]);
    const dto = await service.growth('ws', WEEK, '2,3,99');
    expect(repo.followerRows).toHaveBeenCalledWith(
      [2, 3],
      '2026-10-13',
      '2026-10-20',
    );
    expect(dto.channels.map((c) => c.channelId).sort()).toEqual([2, 3]);
  });
});

describe('AudienceService.channels', () => {
  const FLAG = process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
  afterEach(() => {
    if (FLAG === undefined) delete process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
    else process.env.FACEBOOK_REQUEST_READ_INSIGHTS = FLAG;
  });

  it('applies the channel filter', async () => {
    const { service } = setup(
      [channel(1, 'instagram'), channel(2, 'twitter'), channel(3, 'threads')],
      [stored(1, HOUR), stored(3, HOUR)],
    );
    const dto = await service.channels('ws', WEEK, '3', NOW);
    expect(dto.channels.map((c) => c.channelId)).toEqual([3]);
  });

  it('maps a fresh stored row to shares and enqueues nothing', async () => {
    const { service, queue } = setup(
      [channel(1, 'instagram')],
      [stored(1, 2 * HOUR)],
    );
    const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
    expect(c).toMatchObject({
      channelId: 1,
      platform: 'instagram',
      status: 'ok',
      measure: 'followers',
      reconnectable: false,
      followerCount: 1001,
      fetchedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      countries: [
        { key: 'US', percent: 75 },
        { key: 'PK', percent: 25 },
      ],
      cities: [{ key: 'Karachi', percent: 100 }],
    });
    expect(c.genders).toEqual([
      { key: 'female', percent: 100 },
      { key: 'male', percent: 0 },
      { key: 'unknown', percent: 0 },
    ]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a stale channel once, with the cron job id, and returns the old row', async () => {
    const { service, queue } = setup(
      [channel(1, 'instagram')],
      [stored(1, 25 * HOUR)],
    );
    const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
    expect(c.status).toBe('ok');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'channel-audience-refresh',
      { channelId: 1 },
      { jobId: 'audience-1-2026-10-20' },
    );
  });

  it('returns pending, with no fetchedAt, for a channel with no row, and enqueues it', async () => {
    const { service, queue } = setup([channel(4, 'facebook')]);
    const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
    expect(c).toMatchObject({
      status: 'pending',
      fetchedAt: null,
      countries: [],
      cities: [],
      ages: [],
      genders: [],
      followerCount: 1004,
      reconnectable: false,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'channel-audience-refresh',
      { channelId: 4 },
      { jobId: 'audience-4-2026-10-20' },
    );
  });

  it('does not fail the read when the enqueue fails', async () => {
    const { service, queue } = setup([channel(4, 'facebook')]);
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(
      service.channels('ws', WEEK, undefined, NOW),
    ).resolves.toBeDefined();
    queue.add.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(
      service.channels('ws', WEEK, undefined, NOW),
    ).resolves.toBeDefined();
  });

  it('reconnectable follows the flag, only for a Facebook no_permission row', async () => {
    const rows = [
      stored(1, HOUR, { status: 'no_permission', countries: [] }),
      stored(2, HOUR, { status: 'no_permission', countries: [] }),
      stored(3, HOUR),
    ];
    const chans = [
      channel(1, 'facebook'),
      channel(2, 'instagram'),
      channel(3, 'facebook'),
    ];
    const flags = (dto: { channels: Array<{ reconnectable: boolean }> }) =>
      dto.channels.map((c) => c.reconnectable);

    process.env.FACEBOOK_REQUEST_READ_INSIGHTS = 'true';
    const on = await setup(chans, rows).service.channels(
      'ws',
      WEEK,
      undefined,
      NOW,
    );
    expect(flags(on)).toEqual([true, false, false]);

    process.env.FACEBOOK_REQUEST_READ_INSIGHTS = 'false';
    const off = await setup(chans, rows).service.channels(
      'ws',
      WEEK,
      undefined,
      NOW,
    );
    expect(flags(off)).toEqual([false, false, false]);

    delete process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
    const unset = await setup(chans, rows).service.channels(
      'ws',
      WEEK,
      undefined,
      NOW,
    );
    expect(flags(unset)).toEqual([false, false, false]);
  });

  it('treats exactly 24h as fresh and 24h + 1ms as stale', async () => {
    const day = 24 * HOUR;
    const fresh = setup([channel(1, 'instagram')], [stored(1, day)]);
    await fresh.service.channels('ws', WEEK, undefined, NOW);
    expect(fresh.queue.add).not.toHaveBeenCalled();

    const stale = setup([channel(1, 'instagram')], [stored(1, day + 1)]);
    await stale.service.channels('ws', WEEK, undefined, NOW);
    expect(stale.queue.add).toHaveBeenCalledTimes(1);
  });

  it('fails only the channel whose stored row cannot be mapped', async () => {
    const { service } = setup(
      [channel(1, 'instagram'), channel(2, 'threads'), channel(3, 'facebook')],
      [stored(1, HOUR, { countries: {} }), stored(2, HOUR), stored(3, HOUR)],
    );
    const { channels } = await service.channels('ws', WEEK, undefined, NOW);
    expect(channels[0]).toMatchObject({
      channelId: 1,
      status: 'failed',
      fetchedAt: null,
      countries: [],
      cities: [],
      ages: [],
      genders: [],
      reconnectable: false,
    });
    expect(channels.map((c) => c.status)).toEqual(['failed', 'ok', 'ok']);
    expect(channels[1].countries.length).toBeGreaterThan(0);
  });

  describe('an inactive channel', () => {
    it('is never enqueued; its stored row is returned as stored, even when stale', async () => {
      const { service, queue } = setup(
        [channel(1, 'instagram', false)],
        [stored(1, 48 * HOUR)],
      );
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c.status).toBe('ok');
      expect(c.countries).toEqual([
        { key: 'US', percent: 75 },
        { key: 'PK', percent: 25 },
      ]);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('with no row is failed, never pending, and is not enqueued', async () => {
      const { service, queue } = setup([channel(1, 'threads', false)]);
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c).toMatchObject({
        status: 'failed',
        fetchedAt: null,
        countries: [],
      });
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  it('marks everything else unsupported', async () => {
    const { service, queue } = setup([
      channel(1, 'twitter'),
      channel(2, 'linkedin'),
    ]);
    const { channels } = await service.channels('ws', WEEK, undefined, NOW);
    expect(channels.map((c) => c.status)).toEqual([
      'unsupported',
      'unsupported',
    ]);
    expect(channels[0]).toMatchObject({
      measure: 'followers',
      fetchedAt: null,
      countries: [],
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  describe('YouTube', () => {
    it('reads live as viewers, then caches under a key that carries the window', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')]);
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c).toMatchObject({
        status: 'ok',
        measure: 'viewers',
        cities: [],
        fetchedAt: NOW.toISOString(),
        followerCount: 1009,
        countries: [
          { key: 'US', percent: 75 },
          { key: 'PK', percent: 25 },
        ],
        ages: [
          { key: '13-17', percent: 0 },
          { key: '18-24', percent: 50 },
          { key: '25-34', percent: 50 },
          { key: '35-44', percent: 0 },
          { key: '45-54', percent: 0 },
          { key: '55+', percent: 0 },
        ],
      });
      expect(c.genders).toEqual([
        { key: 'female', percent: 30 },
        { key: 'male', percent: 70 },
        { key: 'unknown', percent: 0 },
      ]);
      expect(youtube.getDemographics).toHaveBeenCalledWith({
        accessToken: 'plain-tok-9',
        startDate: '2026-10-13',
        endDate: '2026-10-19',
      });
      expect(redis.set).toHaveBeenCalledWith(
        'audience:yt:9:2026-10-13:2026-10-19',
        expect.any(String),
        'EX',
        43200,
      );
    });

    it('keys two windows apart, so a 7-day view never serves 90-day numbers', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')]);
      await service.channels('ws', WEEK, undefined, NOW);
      await service.channels('ws', LONG, undefined, NOW);
      const keys = redis.set.mock.calls.map((call) => call[0]);
      expect(keys).toEqual([
        'audience:yt:9:2026-10-13:2026-10-19',
        'audience:yt:9:2026-07-22:2026-10-19',
      ]);
      // The second window was a miss, not a hit on the first.
      expect(youtube.getDemographics).toHaveBeenCalledTimes(2);
      expect(youtube.getDemographics).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: '2026-07-22' }),
      );
    });

    it('serves a hit from the cache with no client call', async () => {
      const { service, youtube } = setup([channel(9, 'youtube')]);
      const first = await service.channels('ws', WEEK, undefined, NOW);
      youtube.getDemographics.mockClear();
      youtube.getViewsByCountry.mockClear();
      const second = await service.channels('ws', WEEK, undefined, NOW);
      expect(youtube.getDemographics).not.toHaveBeenCalled();
      expect(youtube.getViewsByCountry).not.toHaveBeenCalled();
      expect(second).toEqual(first);
    });

    it('is failed, and not cached, when the client errors', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')]);
      youtube.getViewsByCountry.mockRejectedValue(new Error('quota'));
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c).toMatchObject({
        status: 'failed',
        measure: 'viewers',
        fetchedAt: null,
        countries: [],
        ages: [],
        genders: [],
      });
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('survives Redis failing on read and on write', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')]);
      redis.get.mockRejectedValue(new Error('redis down'));
      redis.set.mockRejectedValue(new Error('redis down'));
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c.status).toBe('ok');
      expect(youtube.getDemographics).toHaveBeenCalledTimes(1);
    });

    it('is failed, and not cached, when the channel has no token row', async () => {
      const { service, youtube, redis } = setup(
        [channel(9, 'youtube'), channel(10, 'youtube')],
        [],
        { noTokenFor: [9] },
      );
      const { channels } = await service.channels('ws', WEEK, undefined, NOW);
      expect(channels.map((c) => c.status)).toEqual(['failed', 'ok']);
      expect(youtube.getDemographics).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set.mock.calls[0][0]).toBe(
        'audience:yt:10:2026-10-13:2026-10-19',
      );
    });

    it('goes live within the timeout when the cache read never resolves', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')]);
      redis.get.mockReturnValue(new Promise(() => undefined));
      const started = Date.now();
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c.status).toBe('ok');
      expect(youtube.getDemographics).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(CACHE_READ_TIMEOUT_MS + 700);
    });

    it('does not touch Redis when the client is not ready', async () => {
      const { service, youtube, redis } = setup([channel(9, 'youtube')], [], {
        redisStatus: 'reconnecting',
      });
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c.status).toBe('ok');
      expect(youtube.getDemographics).toHaveBeenCalledTimes(1);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('does not wait for a cache write that hangs', async () => {
      const { service, redis } = setup([channel(9, 'youtube')]);
      redis.set.mockReturnValue(new Promise(() => undefined));
      const [c] = (await service.channels('ws', WEEK, undefined, NOW)).channels;
      expect(c.status).toBe('ok');
      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue a refresh for YouTube', async () => {
      const { service, queue } = setup([channel(9, 'youtube')]);
      await service.channels('ws', WEEK, undefined, NOW);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});

describe('AudienceService.csv', () => {
  it('names the file for the window', async () => {
    const { service } = setup([channel(1, 'twitter')]);
    const { filename, body } = await service.csv('ws', WEEK, undefined);
    expect(filename).toBe('schedura-audience-2026-10-13-2026-10-19.csv');
    expect(body).toContain(
      'date,channel,platform,followers,gained_since_start',
    );
  });
});
