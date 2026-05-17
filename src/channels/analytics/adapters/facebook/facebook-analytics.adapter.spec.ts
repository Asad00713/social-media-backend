import { FacebookAnalyticsAdapter } from './facebook-analytics.adapter';
import { FacebookApiClient, FacebookApiError } from './facebook-api.client';

describe('FacebookAnalyticsAdapter', () => {
  const client = {
    getPage: jest.fn(),
    getPagePosts: jest.fn(),
    getPost: jest.fn(),
    getPostInsights: jest.fn(),
  };
  let adapter: FacebookAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new FacebookAnalyticsAdapter(client as unknown as FacebookApiClient);
  });

  it('exposes platform=facebook and correct vocabulary', () => {
    expect(adapter.platform).toBe('facebook');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.vocabulary.share).toBe('share');
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.hasDemographics).toBe(true);
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('fetchProfileSnapshot returns followers_count when present, falls back to fan_count', async () => {
    client.getPage.mockResolvedValue({
      id: 'page-123',
      name: 'My Page',
      fan_count: 10000,
      followers_count: 9500,
      category: 'Software',
      verification_status: 'blue_verified',
      picture: { data: { url: 'https://example.com/pic.jpg' } },
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'page-123',
      accessToken: 'page-access-token',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(9500); // prefers followers_count
      expect(result.data.followingCount).toBeNull();
      expect(result.data.platformMetrics.fanCount).toBe(10000);
      expect(result.data.platformMetrics.pictureUrl).toBe('https://example.com/pic.jpg');
      expect(result.data.platformMetrics.category).toBe('Software');
    }
  });

  it('fetchProfileSnapshot falls back to fan_count when followers_count is absent', async () => {
    client.getPage.mockResolvedValue({
      id: 'page-123',
      name: 'My Page',
      fan_count: 8000,
      // followers_count absent
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'page-123',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(8000);
    }
  });

  it('fetchProfileSnapshot returns failed on auth_failed error', async () => {
    client.getPage.mockRejectedValue(
      new FacebookApiError('auth_failed', 400, 'Invalid OAuth access token.'),
    );

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'page-123',
      accessToken: 'bad-token',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('Invalid OAuth access token.');
    }
  });

  it('fetchRecentPosts maps API response to RecentPost array', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    client.getPagePosts.mockResolvedValue({
      data: [
        {
          id: 'post-1',
          message: 'Hello world',
          created_time: now.toISOString(),
          full_picture: 'https://example.com/img.jpg',
          permalink_url: 'https://facebook.com/post-1',
          reactions: { summary: { total_count: 100 } },
          comments: { summary: { total_count: 25 } },
          shares: { count: 10 },
          likes: { summary: { total_count: 95 } },
        },
        {
          id: 'post-2',
          created_time: now.toISOString(),
          // no message, no picture — tests optional fields
        },
      ],
      paging: {},
    });

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'page-123', accessToken: 'tok' } as any,
      { since: new Date('2026-04-01'), limit: 10 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(2);

      const first = result.data.posts[0];
      expect(first.platformPostId).toBe('post-1');
      expect(first.content).toBe('Hello world');
      expect(first.mediaUrl).toBe('https://example.com/img.jpg');
      // likes.summary.total_count takes precedence over reactions
      expect(first.metrics.likesCount).toBe(95);
      expect(first.metrics.commentsCount).toBe(25);
      expect(first.metrics.sharesCount).toBe(10);
      expect(first.metrics.impressionsCount).toBeNull();
      expect(first.metrics.reachCount).toBeNull();
      expect(first.metrics.platformMetrics.permalinkUrl).toBe('https://facebook.com/post-1');

      const second = result.data.posts[1];
      expect(second.platformPostId).toBe('post-2');
      expect(second.content).toBe('');
      expect(second.mediaUrl).toBeNull();
      expect(second.metrics.likesCount).toBe(0);
    }
  });

  it('fetchRecentPosts returns failed on API error', async () => {
    client.getPagePosts.mockRejectedValue(
      new FacebookApiError('rate_limited', 400, 'Application request limit reached.'),
    );

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'page-123', accessToken: 'tok' } as any,
      { since: new Date(), limit: 10 },
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
    }
  });

  it('fetchPostMetrics returns partial when insights fail but post stats succeed', async () => {
    client.getPost.mockResolvedValue({
      id: 'post-1',
      created_time: new Date().toISOString(),
      likes: { summary: { total_count: 50 } },
      comments: { summary: { total_count: 10 } },
      shares: { count: 5 },
      permalink_url: 'https://facebook.com/post-1',
    });
    client.getPostInsights.mockRejectedValue(
      new FacebookApiError('permanent', 400, 'Insights not available for this post type.'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'post-1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.likesCount).toBe(50);
      expect(result.data.impressionsCount).toBeNull();
      expect(result.missing).toContain('post_impressions');
    }
  });

  it('fetchPostMetrics returns success when both post and insights succeed', async () => {
    client.getPost.mockResolvedValue({
      id: 'post-1',
      created_time: new Date().toISOString(),
      reactions: { summary: { total_count: 200 } },
      comments: { summary: { total_count: 30 } },
      shares: { count: 15 },
    });
    client.getPostInsights.mockResolvedValue({
      data: [
        { name: 'post_impressions', period: 'lifetime', values: [{ value: 5000 }] },
        { name: 'post_impressions_unique', period: 'lifetime', values: [{ value: 3200 }] },
        { name: 'post_engaged_users', period: 'lifetime', values: [{ value: 800 }] },
      ],
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'post-1',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(5000);
      expect(result.data.reachCount).toBe(3200);
      expect(result.data.platformMetrics.engagedUsers).toBe(800);
    }
  });
});
