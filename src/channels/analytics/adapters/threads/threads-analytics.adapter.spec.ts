import { ThreadsAnalyticsAdapter } from './threads-analytics.adapter';
import { ThreadsApiClient, ThreadsApiError } from './threads-api.client';

describe('ThreadsAnalyticsAdapter', () => {
  const client = {
    getMe: jest.fn(),
    getMyThreads: jest.fn(),
    getThread: jest.fn(),
    getThreadInsights: jest.fn(),
    getUserInsights: jest.fn(),
  };
  let adapter: ThreadsAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ThreadsAnalyticsAdapter(
      client as unknown as ThreadsApiClient,
    );
  });

  it('exposes platform=threads and correct vocabulary', () => {
    expect(adapter.platform).toBe('threads');
    expect(adapter.capabilities.vocabulary.post).toBe('thread');
    expect(adapter.capabilities.vocabulary.share).toBe('repost');
    expect(adapter.capabilities.hasFollowerCount).toBe(true);
    expect(adapter.capabilities.hasFollowingCount).toBe(false);
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.hasReach).toBe(false);
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('fetchProfileSnapshot returns success with followers from insights', async () => {
    client.getMe.mockResolvedValue({
      id: 'u-123',
      username: 'threaduser',
      name: 'Thread User',
      threads_profile_picture_url: 'https://example.com/pic.jpg',
      threads_biography: 'My bio',
    });
    client.getUserInsights.mockResolvedValue({
      data: [
        {
          name: 'followers_count',
          period: 'lifetime',
          values: [{ value: 4200 }],
        },
        { name: 'views', period: 'day', values: [{ value: 500 }] },
      ],
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'u-123',
      accessToken: 'valid-token',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(4200);
      expect(result.data.followingCount).toBeNull(); // Threads API does not expose
      expect(result.data.platformMetrics.username).toBe('threaduser');
      expect(result.data.platformMetrics.biography).toBe('My bio');
    }
  });

  it('fetchProfileSnapshot returns partial when insights fail', async () => {
    client.getMe.mockResolvedValue({
      id: 'u-123',
      username: 'threaduser',
    });
    client.getUserInsights.mockRejectedValue(
      new ThreadsApiError('permanent', 400, 'Insights not available'),
    );

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'u-123',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.followersCount).toBeNull();
      expect(result.missing).toContain('followers_count');
      expect(result.missing).toContain('views');
    }
  });

  it('fetchProfileSnapshot returns failed when getMe fails', async () => {
    client.getMe.mockRejectedValue(
      new ThreadsApiError('auth_failed', 401, 'Invalid OAuth token.'),
    );
    client.getUserInsights.mockResolvedValue({ data: [] });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'u-123',
      accessToken: 'bad-token',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('Invalid OAuth token.');
    }
  });

  it('fetchPostMetrics maps insights correctly to standard fields', async () => {
    client.getThreadInsights.mockResolvedValue({
      data: [
        { name: 'views', period: 'lifetime', values: [{ value: 1500 }] },
        { name: 'likes', period: 'lifetime', values: [{ value: 200 }] },
        { name: 'replies', period: 'lifetime', values: [{ value: 45 }] },
        { name: 'reposts', period: 'lifetime', values: [{ value: 30 }] },
        { name: 'quotes', period: 'lifetime', values: [{ value: 10 }] },
      ],
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'thread-xyz',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(1500); // views → impressions
      expect(result.data.likesCount).toBe(200);
      expect(result.data.commentsCount).toBe(45); // replies → comments
      expect(result.data.sharesCount).toBe(30); // reposts → shares
      expect(result.data.reachCount).toBeNull(); // not available
      expect(result.data.platformMetrics.quotes).toBe(10);
    }
  });

  it('fetchPostMetrics returns failed when insights API errors', async () => {
    client.getThreadInsights.mockRejectedValue(
      new ThreadsApiError('rate_limited', 429, 'Too many requests'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'thread-xyz',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
    }
  });

  it('fetchPostMetrics returns failed when platformPostId is missing', async () => {
    const result = await adapter.fetchPostMetrics({
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('fetchRecentPosts maps API response to RecentPost array', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    client.getMyThreads.mockResolvedValue({
      data: [
        {
          id: 'thread-1',
          text: 'Hello Threads!',
          media_type: 'TEXT',
          timestamp: now.toISOString(),
          permalink: 'https://www.threads.net/@user/post/abc',
        },
        {
          id: 'thread-2',
          media_type: 'IMAGE',
          thumbnail_url: 'https://example.com/thumb.jpg',
          media_url: 'https://example.com/img.jpg',
          timestamp: now.toISOString(),
        },
      ],
      paging: {},
    });

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'u-123', accessToken: 'tok' } as any,
      { since: new Date('2026-04-01'), limit: 25 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(2);

      const first = result.data.posts[0];
      expect(first.platformPostId).toBe('thread-1');
      expect(first.content).toBe('Hello Threads!');
      expect(first.mediaUrl).toBeNull(); // TEXT type, no thumbnail/media
      expect(first.metrics.platformMetrics.mediaType).toBe('TEXT');
      expect(first.metrics.platformMetrics.permalink).toBe(
        'https://www.threads.net/@user/post/abc',
      );

      const second = result.data.posts[1];
      expect(second.platformPostId).toBe('thread-2');
      expect(second.mediaUrl).toBe('https://example.com/thumb.jpg'); // thumbnail preferred
    }
  });
});
