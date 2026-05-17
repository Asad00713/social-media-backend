import { TwitterAnalyticsAdapter } from './twitter-analytics.adapter';
import { TwitterApiClient, TwitterApiError } from './twitter-api.client';

describe('TwitterAnalyticsAdapter', () => {
  const mockClient = {
    getMe: jest.fn(),
    getUserTweets: jest.fn(),
    getTweet: jest.fn(),
  };
  let adapter: TwitterAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new TwitterAnalyticsAdapter(mockClient as unknown as TwitterApiClient);
  });

  it('exposes platform=twitter with correct vocabulary and capabilities', () => {
    expect(adapter.platform).toBe('twitter');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.vocabulary.share).toBe('retweet');
    expect(adapter.capabilities.vocabulary.post).toBe('tweet');
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.dailyQuotaBudget).toBe(500);
    expect(adapter.capabilities.hasReach).toBe(false);
  });

  it('fetchProfileSnapshot success maps public_metrics correctly', async () => {
    mockClient.getMe.mockResolvedValue({
      id: '12345',
      name: 'Test Account',
      username: 'testaccount',
      description: 'A test bio',
      profile_image_url: 'https://pbs.twimg.com/profile/img.jpg',
      verified: true,
      public_metrics: {
        followers_count: 80000,
        following_count: 500,
        tweet_count: 3200,
        listed_count: 42,
      },
    });

    const result = await adapter.fetchProfileSnapshot({
      accessToken: 'bearer-tok',
      platformAccountId: '12345',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(80000);
      expect(result.data.followingCount).toBe(500);
      expect(result.data.totalPostsCount).toBe(3200);
      expect(result.data.platformMetrics.username).toBe('testaccount');
      expect(result.data.platformMetrics.verified).toBe(true);
      expect(result.data.platformMetrics.listedCount).toBe(42);
      expect(result.quotaCostUsed).toBe(1);
    }
  });

  it('fetchPostMetrics sharesCount = retweet_count + quote_count', async () => {
    mockClient.getTweet.mockResolvedValue({
      id: 'tweet1',
      text: 'Hello Twitter',
      created_at: '2024-01-10T10:00:00Z',
      public_metrics: {
        retweet_count: 15,
        reply_count: 8,
        like_count: 120,
        quote_count: 5,
        bookmark_count: 30,
      },
      // No non_public_metrics — simulates free tier
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'tweet1',
      accessToken: 'bearer-tok',
    } as any);

    // No impressions without non_public → partial
    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.sharesCount).toBe(20); // 15 retweets + 5 quotes
      expect(result.data.likesCount).toBe(120);
      expect(result.data.commentsCount).toBe(8);
      expect(result.data.impressionsCount).toBeNull();
      expect(result.data.reachCount).toBeNull();
      expect(result.data.platformMetrics?.retweets).toBe(15);
      expect(result.data.platformMetrics?.quotes).toBe(5);
      expect(result.data.platformMetrics?.bookmarks).toBe(30);
      expect(result.missing).toContain('impressions');
      expect(result.quotaCostUsed).toBe(1);
    }
  });

  it('fetchPostMetrics returns success with impressions when non_public_metrics available', async () => {
    mockClient.getTweet.mockResolvedValue({
      id: 'tweet2',
      text: 'Basic tier tweet',
      created_at: '2024-01-11T12:00:00Z',
      public_metrics: {
        retweet_count: 3,
        reply_count: 1,
        like_count: 50,
        quote_count: 2,
      },
      non_public_metrics: {
        impression_count: 9500,
        user_profile_clicks: 120,
        url_link_clicks: 45,
      },
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'tweet2',
      accessToken: 'bearer-tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(9500);
      expect(result.data.sharesCount).toBe(5); // 3 + 2
      expect(result.data.platformMetrics.profileClicks).toBe(120);
      expect(result.data.platformMetrics.urlClicks).toBe(45);
      expect(result.quotaCostUsed).toBe(1);
    }
  });

  it('fetchProfileSnapshot returns failed on TwitterApiError', async () => {
    mockClient.getMe.mockRejectedValue(
      new TwitterApiError('rate_limited', 429, 'Too Many Requests'),
    );

    const result = await adapter.fetchProfileSnapshot({
      accessToken: 'bearer-tok',
      platformAccountId: '12345',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.message).toBe('Too Many Requests');
      expect(result.quotaCostUsed).toBe(0);
    }
  });

  it('fetchPostMetrics maps tier_required to auth_failed in error result', async () => {
    mockClient.getTweet.mockRejectedValue(
      new TwitterApiError('tier_required', 403, 'Your access level does not permit this'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'tweet3',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
    }
  });

  it('fetchRecentPosts maps tweets to RecentPost with combined sharesCount', async () => {
    mockClient.getUserTweets.mockResolvedValue({
      tweets: [
        {
          id: 'tw1',
          text: 'First tweet',
          created_at: '2024-02-01T08:00:00Z',
          public_metrics: {
            retweet_count: 10,
            reply_count: 3,
            like_count: 75,
            quote_count: 4,
            bookmark_count: 12,
          },
          attachments: { media_keys: ['16_media1'] },
        },
        {
          id: 'tw2',
          text: 'Second tweet no media',
          created_at: '2024-02-02T09:00:00Z',
          public_metrics: {
            retweet_count: 2,
            reply_count: 1,
            like_count: 20,
            quote_count: 0,
          },
        },
      ],
      media: new Map([['16_media1', { url: 'https://pbs.twimg.com/media/img.jpg', type: 'photo' }]]),
    });

    const result = await adapter.fetchRecentPosts(
      { accessToken: 'bearer-tok', platformAccountId: '12345' } as any,
      { since: new Date('2024-01-01'), limit: 10 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(2);
      const first = result.data.posts[0];
      expect(first.platformPostId).toBe('tw1');
      expect(first.metrics.sharesCount).toBe(14); // 10 + 4
      expect(first.metrics.likesCount).toBe(75);
      expect(first.mediaUrl).toBe('https://pbs.twimg.com/media/img.jpg');
      expect(first.metrics.platformMetrics.mediaType).toBe('photo');
      const second = result.data.posts[1];
      expect(second.mediaUrl).toBeNull();
      expect(result.quotaCostUsed).toBe(2);
    }
  });
});
