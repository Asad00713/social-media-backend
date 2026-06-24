import { TikTokAnalyticsAdapter } from './tiktok-analytics.adapter';
import { TikTokApiClient, TikTokApiError } from './tiktok-api.client';

describe('TikTokAnalyticsAdapter', () => {
  const mockClient = {
    getUserInfo: jest.fn(),
    getVideoList: jest.fn(),
    queryVideos: jest.fn(),
  };
  let adapter: TikTokAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new TikTokAnalyticsAdapter(
      mockClient as unknown as TikTokApiClient,
    );
  });

  it('exposes platform=tiktok and followers vocabulary', () => {
    expect(adapter.platform).toBe('tiktok');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.vocabulary.post).toBe('video');
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.dailyQuotaBudget).toBe(1000);
  });

  it('fetchProfileSnapshot success maps TikTok user fields correctly', async () => {
    mockClient.getUserInfo.mockResolvedValue({
      open_id: 'open123',
      union_id: 'union456',
      display_name: 'Test Creator',
      follower_count: 50000,
      following_count: 300,
      likes_count: 1200000,
      video_count: 88,
      is_verified: true,
      avatar_url: 'https://example.com/avatar.jpg',
    });

    const result = await adapter.fetchProfileSnapshot({
      accessToken: 'tok',
      platformAccountId: 'open123',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(50000);
      expect(result.data.followingCount).toBe(300);
      expect(result.data.totalPostsCount).toBe(88);
      expect(result.data.platformMetrics.openId).toBe('open123');
      expect(result.data.platformMetrics.totalLikes).toBe(1200000);
      expect(result.data.platformMetrics.isVerified).toBe(true);
      expect(result.quotaCostUsed).toBe(1);
    }
  });

  it('fetchPostMetrics maps view_count to impressionsCount', async () => {
    mockClient.queryVideos.mockResolvedValue([
      {
        id: 'v1',
        create_time: 1700000000,
        view_count: 99000,
        like_count: 4500,
        comment_count: 200,
        share_count: 150,
        duration: 62,
        share_url: 'https://tiktok.com/@test/video/v1',
        cover_image_url: 'https://example.com/cover.jpg',
      },
    ]);

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'v1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(99000);
      expect(result.data.likesCount).toBe(4500);
      expect(result.data.commentsCount).toBe(200);
      expect(result.data.sharesCount).toBe(150);
      expect(result.data.reachCount).toBeNull();
      expect(result.data.platformMetrics.duration).toBe(62);
      expect(result.quotaCostUsed).toBe(1);
    }
  });

  it('fetchRecentPosts filters videos by since timestamp', async () => {
    const sinceDate = new Date('2024-01-15T00:00:00Z');
    const sinceUnix = sinceDate.getTime() / 1000;

    mockClient.getVideoList.mockResolvedValue({
      videos: [
        {
          id: 'new',
          create_time: sinceUnix + 3600,
          view_count: 1000,
          like_count: 50,
          comment_count: 5,
          share_count: 2,
        },
        {
          id: 'old',
          create_time: sinceUnix - 3600,
          view_count: 500,
          like_count: 20,
          comment_count: 2,
          share_count: 1,
        },
      ],
      cursor: 20,
      hasMore: false,
    });

    const result = await adapter.fetchRecentPosts(
      { accessToken: 'tok', platformAccountId: 'open123' } as any,
      { since: sinceDate, limit: 20 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(1);
      expect(result.data.posts[0].platformPostId).toBe('new');
      expect(result.quotaCostUsed).toBe(2);
    }
  });

  it('fetchProfileSnapshot returns failed on TikTokApiError', async () => {
    mockClient.getUserInfo.mockRejectedValue(
      new TikTokApiError('rate_limited', 429, 'Too many requests'),
    );

    const result = await adapter.fetchProfileSnapshot({
      accessToken: 'tok',
      platformAccountId: 'open123',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.message).toBe('Too many requests');
    }
  });

  it('fetchPostMetrics returns not_found when queryVideos returns empty array', async () => {
    mockClient.queryVideos.mockResolvedValue([]);

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'missing',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });
});
