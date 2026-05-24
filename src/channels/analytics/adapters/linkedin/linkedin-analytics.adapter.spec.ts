import { LinkedInAnalyticsAdapter } from './linkedin-analytics.adapter';
import { LinkedInApiClient, LinkedInApiError } from './linkedin-api.client';

describe('LinkedInAnalyticsAdapter', () => {
  const client = {
    getUserInfo: jest.fn(),
    getMemberPosts: jest.fn(),
    getSocialActions: jest.fn(),
  };
  let adapter: LinkedInAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LinkedInAnalyticsAdapter(client as unknown as LinkedInApiClient);
  });

  it('exposes platform=linkedin with correct capabilities and vocabulary', () => {
    expect(adapter.platform).toBe('linkedin');
    // LinkedIn personal API cannot expose follower counts
    expect(adapter.capabilities.hasFollowerCount).toBe(false);
    expect(adapter.capabilities.hasFollowerTimeSeries).toBe(false);
    expect(adapter.capabilities.hasFollowingCount).toBe(false);
    expect(adapter.capabilities.hasImpressions).toBe(false);
    expect(adapter.capabilities.hasReach).toBe(false);
    expect(adapter.capabilities.hasEngagementRate).toBe(true);
    expect(adapter.capabilities.hasVideoMetrics).toBe(false);
    expect(adapter.capabilities.hasDemographics).toBe(false);
    expect(adapter.capabilities.hasEphemeralContent).toBe(false);
    expect(adapter.capabilities.ephemeralTTLHours).toBeNull();
    // LinkedIn vocabulary: connections not followers
    expect(adapter.capabilities.vocabulary.follower).toBe('connections');
    expect(adapter.capabilities.vocabulary.following).toBe('connections');
    expect(adapter.capabilities.vocabulary.share).toBe('share');
    expect(adapter.capabilities.vocabulary.post).toBe('post');
    expect(adapter.capabilities.contentTypes).toContain('post');
    expect(adapter.capabilities.contentTypes).toContain('article');
    expect(adapter.capabilities.dataFreshness).toBe('daily');
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('pollingProfile has post and article schedules ending with final', () => {
    const postSchedule = adapter.pollingProfile.schedulePerContentType?.post;
    expect(postSchedule).toBeDefined();
    expect(postSchedule![0]).toBe('6h');
    expect(postSchedule![postSchedule!.length - 1]).toBe('final');
    expect(postSchedule).toContain('7d');
    expect(postSchedule).toContain('30d');
    expect(adapter.pollingProfile.defaultContentType).toBe('post');

    const articleSchedule = adapter.pollingProfile.schedulePerContentType?.article;
    expect(articleSchedule).toBeDefined();
    expect(articleSchedule![articleSchedule!.length - 1]).toBe('final');
  });

  describe('fetchProfileSnapshot', () => {
    it('always returns status=partial with missing follower/following/post counts (platform design)', async () => {
      client.getUserInfo.mockResolvedValue({
        sub: 'abc123',
        name: 'Jane Doe',
        given_name: 'Jane',
        family_name: 'Doe',
        picture: 'https://media.licdn.com/pic.jpg',
        email: 'jane@example.com',
        locale: { country: 'US', language: 'en' },
      });

      const result = await adapter.fetchProfileSnapshot({
        platformAccountId: 'abc123',
        accessToken: 'tok',
      } as any);

      // LinkedIn personal accounts NEVER return follower counts — partial is correct, not an error
      expect(result.status).toBe('partial');
      if (result.status === 'partial') {
        expect(result.data.followersCount).toBeNull();
        expect(result.data.followingCount).toBeNull();
        expect(result.data.totalPostsCount).toBeNull();
        expect(result.missing).toContain('followersCount');
        expect(result.missing).toContain('followingCount');
        expect(result.missing).toContain('totalPostsCount');
        // Basic profile data from /v2/userinfo should still be present
        expect(result.data.platformMetrics!['sub']).toBe('abc123');
        expect(result.data.platformMetrics!['name']).toBe('Jane Doe');
        expect(result.data.platformMetrics!['givenName']).toBe('Jane');
        expect(result.data.platformMetrics!['picture']).toBe('https://media.licdn.com/pic.jpg');
        expect(result.data.platformMetrics!['locale']).toEqual({ country: 'US', language: 'en' });
        expect(typeof result.data.platformMetrics!['note']).toBe('string');
      }
    });

    it('returns failed when getUserInfo throws auth error', async () => {
      client.getUserInfo.mockRejectedValue(
        new LinkedInApiError('auth_failed', 401, 'Unauthorized'),
      );

      const result = await adapter.fetchProfileSnapshot({
        platformAccountId: 'abc123',
        accessToken: 'bad-token',
      } as any);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('auth_failed');
        expect(result.error.message).toBe('Unauthorized');
      }
    });

    it('returns failed when getUserInfo throws transient error', async () => {
      client.getUserInfo.mockRejectedValue(
        new LinkedInApiError('transient', 503, 'Service Unavailable'),
      );

      const result = await adapter.fetchProfileSnapshot({
        platformAccountId: 'abc123',
        accessToken: 'tok',
      } as any);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('transient');
      }
    });
  });

  describe('fetchPostMetrics', () => {
    it('returns success with like/comment/share counts when socialActions succeeds', async () => {
      client.getSocialActions.mockResolvedValue({
        likesSummary: { aggregatedTotalLikes: 87 },
        commentsSummary: { aggregatedTotalComments: 12 },
        shareStatistics: { shareCount: 5 },
      });

      const result = await adapter.fetchPostMetrics({
        platformPostId: 'urn:li:share:12345',
        accessToken: 'tok',
      } as any);

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.data.likesCount).toBe(87);
        expect(result.data.commentsCount).toBe(12);
        expect(result.data.sharesCount).toBe(5);
        expect(result.data.impressionsCount).toBeNull();
        expect(result.data.reachCount).toBeNull();
      }
    });

    it('returns partial (not failed) when socialActions gets 403 access_denied', async () => {
      client.getSocialActions.mockRejectedValue(
        new LinkedInApiError('access_denied', 403, 'Forbidden — Marketing Developer Platform required'),
      );

      const result = await adapter.fetchPostMetrics({
        platformPostId: 'urn:li:share:12345',
        accessToken: 'tok',
      } as any);

      // access_denied on socialActions is a known limitation, not an app error
      expect(result.status).toBe('partial');
      if (result.status === 'partial') {
        expect(result.data.likesCount).toBeNull();
        expect(result.data.commentsCount).toBeNull();
        expect(result.data.sharesCount).toBeNull();
        expect(result.missing).toContain('likesCount');
        expect(result.missing).toContain('commentsCount');
        expect(result.missing).toContain('sharesCount');
        expect(typeof result.data.platformMetrics!['note']).toBe('string');
      }
    });

    it('returns failed when platformPostId is missing', async () => {
      const result = await adapter.fetchPostMetrics({
        platformPostId: '',
        accessToken: 'tok',
      } as any);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('not_found');
      }
    });

    it('returns failed when socialActions throws rate_limited', async () => {
      client.getSocialActions.mockRejectedValue(
        new LinkedInApiError('rate_limited', 429, 'Too Many Requests'),
      );

      const result = await adapter.fetchPostMetrics({
        platformPostId: 'urn:li:share:12345',
        accessToken: 'tok',
      } as any);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('rate_limited');
      }
    });
  });

  describe('fetchRecentPosts', () => {
    it('maps post list and filters by since date', async () => {
      const now = new Date('2026-05-10T12:00:00Z');
      const old = new Date('2026-04-01T00:00:00Z');

      client.getMemberPosts.mockResolvedValue({
        paging: { count: 25, start: 0 },
        elements: [
          {
            id: 'urn:li:share:111',
            author: 'urn:li:person:abc123',
            commentary: 'Great news today',
            publishedAt: now.getTime(),
            visibility: 'PUBLIC',
            lifecycleState: 'PUBLISHED',
            content: {
              article: { source: 'https://example.com', title: 'Article', thumbnail: 'https://img.com/t.jpg' },
            },
          },
          {
            id: 'urn:li:share:222',
            author: 'urn:li:person:abc123',
            commentary: 'Old post',
            publishedAt: old.getTime(), // too old — should be filtered
          },
        ],
      });

      const since = new Date('2026-04-15T00:00:00Z');
      const result = await adapter.fetchRecentPosts(
        { platformAccountId: 'abc123', accessToken: 'tok' } as any,
        { since, limit: 25 },
      );

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.data.posts).toHaveLength(1);
        const post = result.data.posts[0];
        expect(post.platformPostId).toBe('urn:li:share:111');
        expect(post.content).toBe('Great news today');
        expect(post.mediaUrl).toBe('https://img.com/t.jpg');
        expect(post.metrics.likesCount).toBe(0);
        expect(post.metrics.commentsCount).toBe(0);
        expect(post.metrics.sharesCount).toBeNull();
        expect(post.metrics.impressionsCount).toBeNull();
        expect(post.metrics.platformMetrics.visibility).toBe('PUBLIC');
        expect(post.metrics.platformMetrics.lifecycleState).toBe('PUBLISHED');
      }
    });

    it('returns partial with empty posts list (not failed) when getMemberPosts gets 403', async () => {
      client.getMemberPosts.mockRejectedValue(
        new LinkedInApiError('access_denied', 403, 'Forbidden — Members posts API requires higher access'),
      );

      const result = await adapter.fetchRecentPosts(
        { platformAccountId: 'abc123', accessToken: 'tok' } as any,
        { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), limit: 25 },
      );

      // access_denied on posts API is a known LinkedIn limitation — return empty, not error
      expect(result.status).toBe('partial');
      if (result.status === 'partial') {
        expect(result.data.posts).toHaveLength(0);
        expect(result.missing).toContain('posts');
      }
    });

    it('returns failed when getMemberPosts throws auth_failed', async () => {
      client.getMemberPosts.mockRejectedValue(
        new LinkedInApiError('auth_failed', 401, 'Unauthorized'),
      );

      const result = await adapter.fetchRecentPosts(
        { platformAccountId: 'abc123', accessToken: 'bad-token' } as any,
        { since: new Date(), limit: 25 },
      );

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('auth_failed');
      }
    });

    it('returns posts with null mediaUrl when no article thumbnail present', async () => {
      client.getMemberPosts.mockResolvedValue({
        elements: [
          {
            id: 'urn:li:share:333',
            author: 'urn:li:person:abc123',
            commentary: 'Text-only post',
            publishedAt: Date.now(),
            visibility: 'PUBLIC',
          },
        ],
      });

      const result = await adapter.fetchRecentPosts(
        { platformAccountId: 'abc123', accessToken: 'tok' } as any,
        { since: new Date(Date.now() - 60000), limit: 25 },
      );

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.data.posts[0].mediaUrl).toBeNull();
      }
    });
  });
});
