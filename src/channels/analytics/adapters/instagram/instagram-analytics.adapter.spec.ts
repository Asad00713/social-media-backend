import { InstagramAnalyticsAdapter } from './instagram-analytics.adapter';
import { InstagramApiClient, InstagramApiError } from './instagram-api.client';

describe('InstagramAnalyticsAdapter', () => {
  const client = {
    getUser: jest.fn(),
    getUserMedia: jest.fn(),
    getMedia: jest.fn(),
    getMediaInsights: jest.fn(),
  };
  let adapter: InstagramAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new InstagramAnalyticsAdapter(client as unknown as InstagramApiClient);
  });

  it('exposes platform=instagram with correct capabilities and vocabulary', () => {
    expect(adapter.platform).toBe('instagram');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.hasEphemeralContent).toBe(true);
    expect(adapter.capabilities.ephemeralTTLHours).toBe(24);
    expect(adapter.capabilities.contentTypes).toContain('story');
    expect(adapter.capabilities.contentTypes).toContain('reel');
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('pollingProfile has compressed story schedule that fits within 24h TTL', () => {
    const storySchedule = adapter.pollingProfile.schedulePerContentType?.story;
    expect(storySchedule).toBeDefined();
    expect(storySchedule![0]).toBe('30m');
    expect(storySchedule![storySchedule!.length - 1]).toBe('final');
    // Story schedule must be shorter than post schedule (no 3d/7d/30d buckets needed)
    const postSchedule = adapter.pollingProfile.schedulePerContentType?.post;
    expect(storySchedule!.length).toBeLessThan(postSchedule!.length);
    // Must not contain long-lived buckets irrelevant for 24h expiry
    expect(storySchedule).not.toContain('3d');
    expect(storySchedule).not.toContain('7d');
    expect(storySchedule).not.toContain('30d');
  });

  it('fetchProfileSnapshot maps IG user fields correctly', async () => {
    client.getUser.mockResolvedValue({
      id: 'ig-user-123',
      username: 'testaccount',
      name: 'Test Account',
      profile_picture_url: 'https://example.com/pic.jpg',
      followers_count: 12000,
      follows_count: 500,
      media_count: 150,
      biography: 'Test bio',
      website: 'https://example.com',
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'ig-user-123',
      accessToken: 'page-access-token',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(12000);
      expect(result.data.followingCount).toBe(500);
      expect(result.data.totalPostsCount).toBe(150);
      expect(result.data.platformMetrics.username).toBe('testaccount');
      expect(result.data.platformMetrics.profilePictureUrl).toBe('https://example.com/pic.jpg');
      expect(result.data.platformMetrics.biography).toBe('Test bio');
      expect(result.data.platformMetrics.website).toBe('https://example.com');
    }
  });

  it('fetchProfileSnapshot returns failed on auth_failed error', async () => {
    client.getUser.mockRejectedValue(
      new InstagramApiError('auth_failed', 400, 'Invalid OAuth access token.'),
    );

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'ig-user-123',
      accessToken: 'bad-token',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('Invalid OAuth access token.');
    }
  });

  it('fetchPostMetrics returns success when both media and insights succeed', async () => {
    client.getMedia.mockResolvedValue({
      id: 'media-1',
      media_type: 'IMAGE',
      timestamp: new Date().toISOString(),
      like_count: 200,
      comments_count: 30,
      permalink: 'https://www.instagram.com/p/abc123/',
    });
    client.getMediaInsights.mockResolvedValue({
      data: [
        { name: 'impressions', period: 'lifetime', values: [{ value: 5000 }] },
        { name: 'reach', period: 'lifetime', values: [{ value: 3500 }] },
        { name: 'engagement', period: 'lifetime', values: [{ value: 250 }] },
        { name: 'saved', period: 'lifetime', values: [{ value: 45 }] },
      ],
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'media-1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.likesCount).toBe(200);
      expect(result.data.commentsCount).toBe(30);
      expect(result.data.impressionsCount).toBe(5000);
      expect(result.data.reachCount).toBe(3500);
      expect(result.data.platformMetrics.saved).toBe(45);
      expect(result.data.platformMetrics.engagement).toBe(250);
      expect(result.data.platformMetrics.permalink).toBe('https://www.instagram.com/p/abc123/');
    }
  });

  it('fetchPostMetrics returns partial when insights fail but media stats succeed', async () => {
    client.getMedia.mockResolvedValue({
      id: 'media-1',
      media_type: 'REEL',
      timestamp: new Date().toISOString(),
      like_count: 500,
      comments_count: 80,
    });
    client.getMediaInsights.mockRejectedValue(
      new InstagramApiError('permanent', 400, 'Insights not available for this media type.'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'media-1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.likesCount).toBe(500);
      expect(result.data.impressionsCount).toBeNull();
      expect(result.data.reachCount).toBeNull();
      expect(result.missing).toContain('impressions');
      expect(result.missing).toContain('reach');
    }
  });

  it('fetchPostMetrics returns failed when media fetch fails', async () => {
    client.getMedia.mockRejectedValue(
      new InstagramApiError('not_found', 404, 'Media not found.'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'media-1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('fetchRecentPosts maps media list to RecentPost array and filters by since', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const old = new Date('2026-04-01T00:00:00Z');
    client.getUserMedia.mockResolvedValue({
      data: [
        {
          id: 'media-1',
          caption: 'A great reel',
          media_type: 'REEL',
          thumbnail_url: 'https://example.com/thumb.jpg',
          media_url: 'https://example.com/video.mp4',
          permalink: 'https://www.instagram.com/reel/abc/',
          timestamp: now.toISOString(),
          like_count: 1000,
          comments_count: 50,
        },
        {
          id: 'media-2',
          media_type: 'IMAGE',
          timestamp: old.toISOString(), // too old — should be filtered out
          like_count: 10,
          comments_count: 1,
        },
      ],
    });

    const since = new Date('2026-04-15T00:00:00Z');
    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'ig-user-123', accessToken: 'tok' } as any,
      { since, limit: 25 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      // media-2 predates `since`, so only media-1 should be included
      expect(result.data.posts).toHaveLength(1);

      const post = result.data.posts[0];
      expect(post.platformPostId).toBe('media-1');
      expect(post.content).toBe('A great reel');
      // thumbnail_url takes priority over media_url
      expect(post.mediaUrl).toBe('https://example.com/thumb.jpg');
      expect(post.metrics.likesCount).toBe(1000);
      expect(post.metrics.commentsCount).toBe(50);
      expect(post.metrics.sharesCount).toBeNull();
      expect(post.metrics.impressionsCount).toBeNull();
      expect(post.metrics.platformMetrics.mediaType).toBe('REEL');
      expect(post.metrics.platformMetrics.permalink).toBe('https://www.instagram.com/reel/abc/');
    }
  });

  it('fetchRecentPosts returns failed on rate_limited error', async () => {
    client.getUserMedia.mockRejectedValue(
      new InstagramApiError('rate_limited', 400, 'Application request limit reached.'),
    );

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'ig-user-123', accessToken: 'tok' } as any,
      { since: new Date(), limit: 25 },
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
    }
  });

  it('fetchPostMetrics returns failed with not_found when mediaId is missing', async () => {
    const result = await adapter.fetchPostMetrics({
      platformPostId: '',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });
});
