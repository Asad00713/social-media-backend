import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PublishedPost } from '../../post-performance/post-performance';
import type { PostPerformanceRepository } from '../../post-performance/post-performance.repository';
import { PLANNER_PREF_DEFAULTS } from '../lib/planner-prefs';
import { BestTimesService } from './best-times.service';
import type { PlannerPreferencesService } from './planner-preferences.service';

const NOW = new Date('2026-06-15T12:00:00Z'); // a Monday
const WEEK = 7 * 86_400_000;
const MONDAY_10 = Date.parse('2026-06-08T10:00:00Z');
const TUESDAY_15 = Date.parse('2026-06-09T15:00:00Z');

let seq = 0;
const post = (
  channelId: number,
  at: number,
  likes: number | null,
): PublishedPost => ({
  postId: `p${seq++}`,
  channelId,
  publishedOn: new Date(at).toISOString().slice(0, 10),
  publishedAt: new Date(at).toISOString(),
  likes,
  comments: likes === null ? null : 0,
  shares: likes === null ? null : 0,
  impressions: null,
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
});

/** `n` posts one week apart (and a minute apart) starting at `base`. */
const slot = (channelId: number, base: number, n: number, likes: number) =>
  Array.from({ length: n }, (_, i) =>
    post(channelId, base - i * WEEK + i * 60_000, likes),
  );

interface Ch {
  id: number;
  platform: SupportedPlatform;
}

function build(opts: {
  channels: Ch[];
  posts?: PublishedPost[];
  timezone?: string;
  source?: 'own' | 'general';
  snapshot?: number;
}) {
  const state = { snapshot: opts.snapshot ?? 1000 };
  const publishedPosts = jest.fn(() => Promise.resolve(opts.posts ?? []));
  const prefsGet = jest.fn(() =>
    Promise.resolve({
      ...PLANNER_PREF_DEFAULTS,
      bestTimesSource: opts.source ?? PLANNER_PREF_DEFAULTS.bestTimesSource,
    }),
  );

  class TestService extends BestTimesService {
    protected loadActiveChannels = () => Promise.resolve(opts.channels);
    protected latestSnapshotMs = () => Promise.resolve(state.snapshot);
  }
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ timezone: opts.timezone ?? 'UTC' }]),
      }),
    }),
  };
  const service = new TestService(
    fakeDb as never,
    { publishedPosts } as unknown as PostPerformanceRepository,
    { get: prefsGet } as unknown as PlannerPreferencesService,
  );
  return { service, publishedPosts, prefsGet, state };
}

describe('BestTimesService', () => {
  it('returns no channels for a workspace without social channels', async () => {
    const { service, publishedPosts } = build({
      channels: [],
      timezone: 'Asia/Karachi',
    });
    await expect(service.getForWorkspace('w', 'u', NOW)).resolves.toEqual({
      timezone: 'Asia/Karachi',
      channels: [],
    });
    expect(publishedPosts).not.toHaveBeenCalled();
  });

  it('a channel with no posts is general with postCount 0', async () => {
    const { service } = build({ channels: [{ id: 1, platform: 'instagram' }] });
    const res = await service.getForWorkspace('w', 'u', NOW);
    expect(res.channels).toHaveLength(1);
    expect(res.channels[0]).toMatchObject({
      channelId: 1,
      platform: 'instagram',
      source: 'general',
      postCount: 0,
      windowDays: 90,
    });
    expect(res.channels[0].windows.length).toBeGreaterThan(0);
    expect(res.channels[0].windows.every((w) => w.multiplier === null)).toBe(
      true,
    );
  });

  it('a platform with no research returns general with empty windows', async () => {
    const { service } = build({ channels: [{ id: 1, platform: 'youtube' }] });
    const res = await service.getForWorkspace('w', 'u', NOW);
    expect(res.channels[0]).toMatchObject({
      source: 'general',
      postCount: 0,
      windows: [],
    });
  });

  it('computes each channel from its own posts only (same platform)', async () => {
    const posts = [
      // hot: 16 posts, median 100
      ...slot(1, MONDAY_10, 10, 100),
      ...slot(1, TUESDAY_15, 6, 50),
      // cold: 17 posts, median 2
      ...slot(2, MONDAY_10, 6, 4),
      ...slot(2, TUESDAY_15, 11, 2),
      // quiet: 14 posts, below the 15-post gate alone, above it merged
      ...slot(3, MONDAY_10, 12, 7),
      ...slot(3, TUESDAY_15, 2, 7),
    ];
    const { service } = build({
      channels: [
        { id: 1, platform: 'instagram' },
        { id: 2, platform: 'instagram' },
        { id: 3, platform: 'instagram' },
      ],
      posts,
    });
    const res = await service.getForWorkspace('w', 'u', NOW);
    const [hot, cold, quiet] = res.channels;

    expect(hot).toMatchObject({ channelId: 1, source: 'own', postCount: 16 });
    expect(hot.windows).toEqual([
      { weekday: 1, hour: 10, multiplier: 1 },
      { weekday: 2, hour: 15, multiplier: 0.5 },
    ]);
    expect(cold).toMatchObject({ channelId: 2, source: 'own', postCount: 17 });
    expect(cold.windows).toEqual([
      { weekday: 1, hour: 10, multiplier: 2 },
      { weekday: 2, hour: 15, multiplier: 1 },
    ]);
    expect(quiet).toMatchObject({
      channelId: 3,
      source: 'general',
      postCount: 14,
    });
  });

  it('caches while the snapshot version is unchanged', async () => {
    const { service, publishedPosts } = build({
      channels: [{ id: 1, platform: 'instagram' }],
    });
    await service.getForWorkspace('w', 'u', NOW);
    await service.getForWorkspace('w', 'u', NOW);
    expect(publishedPosts).toHaveBeenCalledTimes(1);
  });

  it('concurrent cold requests share one query', async () => {
    const { service, publishedPosts } = build({
      channels: [{ id: 1, platform: 'instagram' }],
    });
    await Promise.all([
      service.getForWorkspace('w', 'u', NOW),
      service.getForWorkspace('w', 'u', NOW),
    ]);
    expect(publishedPosts).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not cached', async () => {
    const { service, publishedPosts } = build({
      channels: [{ id: 1, platform: 'instagram' }],
    });
    publishedPosts.mockRejectedValueOnce(new Error('db down'));
    await expect(service.getForWorkspace('w', 'u', NOW)).rejects.toThrow();
    await expect(service.getForWorkspace('w', 'u', NOW)).resolves.toBeDefined();
    expect(publishedPosts).toHaveBeenCalledTimes(2);
  });

  it('recomputes when a newer snapshot exists', async () => {
    const { service, publishedPosts, state } = build({
      channels: [{ id: 1, platform: 'instagram' }],
    });
    await service.getForWorkspace('w', 'u', NOW);
    state.snapshot = 2000;
    await service.getForWorkspace('w', 'u', NOW);
    expect(publishedPosts).toHaveBeenCalledTimes(2);
  });

  it('forceGeneral answers general without touching the cached own data', async () => {
    const posts = [
      ...slot(1, MONDAY_10, 10, 100),
      ...slot(1, TUESDAY_15, 6, 50),
    ];
    // One service, one cache: a general reader must not poison an own one.
    const { service, publishedPosts, prefsGet } = build({
      channels: [{ id: 1, platform: 'instagram' }],
      posts,
    });
    prefsGet
      .mockResolvedValueOnce({
        ...PLANNER_PREF_DEFAULTS,
        bestTimesSource: 'general',
      })
      .mockResolvedValueOnce({
        ...PLANNER_PREF_DEFAULTS,
        bestTimesSource: 'own',
      });
    const a = await service.getForWorkspace('w', 'forcer', NOW);
    const b = await service.getForWorkspace('w', 'owner', NOW);
    expect(a.channels[0]).toMatchObject({ source: 'general', postCount: 16 });
    expect(a.channels[0].windows.every((w) => w.multiplier === null)).toBe(
      true,
    );
    expect(b.channels[0].source).toBe('own');
    expect(publishedPosts).toHaveBeenCalledTimes(1);
  });

  it('an invalid stored zone computes as UTC', async () => {
    const posts = [
      ...slot(1, MONDAY_10, 10, 100),
      ...slot(1, TUESDAY_15, 6, 50),
    ];
    const { service } = build({
      channels: [{ id: 1, platform: 'instagram' }],
      posts,
      timezone: 'Mars/Olympus',
    });
    const res = await service.getForWorkspace('w', 'u', NOW);
    expect(res.timezone).toBe('UTC');
    expect(res.channels[0].windows[0]).toMatchObject({ weekday: 1, hour: 10 });
  });

  it('leaves out calendars, storage and messaging channels', async () => {
    const { service, publishedPosts } = build({
      channels: [
        { id: 1, platform: 'instagram' },
        { id: 2, platform: 'google_calendar' },
        { id: 3, platform: 'google_drive' },
        { id: 4, platform: 'slack' },
      ],
    });
    const res = await service.getForWorkspace('w', 'u', NOW);
    expect(res.channels.map((c) => c.channelId)).toEqual([1]);
    expect(publishedPosts).toHaveBeenCalledWith(
      'w',
      [1],
      expect.any(String),
      expect.any(String),
    );
  });
});
