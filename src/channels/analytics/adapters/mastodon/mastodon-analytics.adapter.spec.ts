import { MastodonAnalyticsAdapter } from './mastodon-analytics.adapter';
import { MastodonApiClient, MastodonApiError } from './mastodon-api.client';

describe('MastodonAnalyticsAdapter', () => {
  const mockClient = {
    verifyCredentials: jest.fn(),
    getAccountStatuses: jest.fn(),
    getStatus: jest.fn(),
  };
  let adapter: MastodonAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new MastodonAnalyticsAdapter(
      mockClient as unknown as MastodonApiClient,
    );
  });

  it('exposes platform=mastodon + boost vocabulary + no impressions + null quota', () => {
    expect(adapter.platform).toBe('mastodon');
    expect(adapter.capabilities.vocabulary.share).toBe('boost');
    expect(adapter.capabilities.vocabulary.post).toBe('toot');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.hasImpressions).toBe(false);
    expect(adapter.capabilities.hasVideoMetrics).toBe(false);
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('estimateQuotaCost always returns 0', () => {
    expect(adapter.estimateQuotaCost('fetchProfileSnapshot')).toBe(0);
    expect(adapter.estimateQuotaCost('fetchPostMetrics')).toBe(0);
    expect(adapter.estimateQuotaCost('fetchRecentPosts')).toBe(0);
  });

  it('fetchProfileSnapshot success maps follower/following/post counts and strips HTML from note', async () => {
    mockClient.verifyCredentials.mockResolvedValue({
      id: '109302715060751367',
      username: 'testuser',
      acct: 'testuser@mastodon.social',
      display_name: 'Test User',
      note: '<p>A <strong>bio</strong> with HTML</p>',
      url: 'https://mastodon.social/@testuser',
      avatar: 'https://mastodon.social/avatar.jpg',
      header: 'https://mastodon.social/header.jpg',
      followers_count: 420,
      following_count: 88,
      statuses_count: 73,
      created_at: '2022-12-01T00:00:00.000Z',
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: '109302715060751367',
      accessToken: 'valid-token',
      metadata: { instanceUrl: 'https://mastodon.social' },
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(420);
      expect(result.data.followingCount).toBe(88);
      expect(result.data.totalPostsCount).toBe(73);
      expect(result.data.platformMetrics.handle).toBe(
        'testuser@mastodon.social',
      );
      expect(result.data.platformMetrics.instanceUrl).toBe(
        'https://mastodon.social',
      );
      // HTML stripped
      expect(result.data.platformMetrics.note).toBe('A bio with HTML');
      expect(result.quotaCostUsed).toBe(0);
    }
  });

  it('fetchProfileSnapshot returns failed when instanceUrl is missing from metadata', async () => {
    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: '109302715060751367',
      accessToken: 'valid-token',
      metadata: {},
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toContain('instanceUrl');
      expect(result.quotaCostUsed).toBe(0);
    }
    expect(mockClient.verifyCredentials).not.toHaveBeenCalled();
  });

  it('fetchProfileSnapshot returns failed on MastodonApiError auth_failed', async () => {
    mockClient.verifyCredentials.mockRejectedValue(
      new MastodonApiError('auth_failed', 401, 'The access token is invalid'),
    );

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: '109302715060751367',
      accessToken: 'expired-token',
      metadata: { instanceUrl: 'https://mastodon.social' },
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('The access token is invalid');
      expect(result.quotaCostUsed).toBe(0);
    }
  });

  it('fetchRecentPosts filters by since date and strips HTML from content', async () => {
    const oldDate = new Date('2024-01-01T00:00:00Z');
    const recentDate = new Date('2024-06-01T00:00:00Z');
    const since = new Date('2024-03-01T00:00:00Z');

    mockClient.getAccountStatuses.mockResolvedValue([
      {
        id: '111',
        uri: 'https://mastodon.social/users/testuser/statuses/111',
        url: 'https://mastodon.social/@testuser/111',
        created_at: recentDate.toISOString(),
        content: '<p>Recent <em>toot</em></p>',
        favourites_count: 5,
        reblogs_count: 2,
        replies_count: 1,
        media_attachments: [],
      },
      {
        id: '222',
        uri: 'https://mastodon.social/users/testuser/statuses/222',
        url: 'https://mastodon.social/@testuser/222',
        created_at: oldDate.toISOString(),
        content: '<p>Old toot</p>',
        favourites_count: 1,
        reblogs_count: 0,
        replies_count: 0,
        media_attachments: [],
      },
    ]);

    const result = await adapter.fetchRecentPosts(
      {
        platformAccountId: '109302715060751367',
        accessToken: 'valid-token',
        metadata: { instanceUrl: 'https://mastodon.social' },
      } as any,
      { since, limit: 40 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(1);
      expect(result.data.posts[0].platformPostId).toBe('111');
      expect(result.data.posts[0].content).toBe('Recent toot');
      expect(result.data.posts[0].metrics.likesCount).toBe(5);
      expect(result.data.posts[0].metrics.sharesCount).toBe(2);
      expect(result.data.posts[0].metrics.impressionsCount).toBeNull();
    }
  });
});
