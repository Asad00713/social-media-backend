import { BlueskyAnalyticsAdapter } from './bluesky-analytics.adapter';
import { BlueskyApiClient, BlueskyApiError } from './bluesky-api.client';

describe('BlueskyAnalyticsAdapter', () => {
  const mockClient = {
    getProfile: jest.fn(),
    getAuthorFeed: jest.fn(),
    getPostThread: jest.fn(),
    createSession: jest.fn(),
    refreshSession: jest.fn(),
  };
  let adapter: BlueskyAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new BlueskyAnalyticsAdapter(
      mockClient as unknown as BlueskyApiClient,
    );
  });

  it('exposes platform=bluesky + repost vocabulary', () => {
    expect(adapter.platform).toBe('bluesky');
    expect(adapter.capabilities.vocabulary.share).toBe('repost');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.hasImpressions).toBe(false);
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
  });

  it('estimateQuotaCost always returns 0', () => {
    expect(adapter.estimateQuotaCost('fetchProfileSnapshot')).toBe(0);
    expect(adapter.estimateQuotaCost('fetchPostMetrics')).toBe(0);
    expect(adapter.estimateQuotaCost('fetchRecentPosts')).toBe(0);
  });

  it('fetchProfileSnapshot success returns mapped follower/following/post counts', async () => {
    mockClient.getProfile.mockResolvedValue({
      did: 'did:plc:abc123',
      handle: 'asad289.bsky.social',
      displayName: 'Asad',
      description: 'Test bio',
      avatar: 'https://cdn.bsky.app/avatar.jpg',
      banner: null,
      followersCount: 420,
      followsCount: 88,
      postsCount: 73,
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'did:plc:abc123',
      username: 'asad289.bsky.social',
      accessToken: 'valid-jwt',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(420);
      expect(result.data.followingCount).toBe(88);
      expect(result.data.totalPostsCount).toBe(73);
      expect(result.data.platformMetrics.did).toBe('did:plc:abc123');
      expect(result.data.platformMetrics.displayName).toBe('Asad');
      expect(result.quotaCostUsed).toBe(0);
    }
  });

  it('fetchProfileSnapshot returns failed on BlueskyApiError auth_failed', async () => {
    mockClient.getProfile.mockRejectedValue(
      new BlueskyApiError('auth_failed', 401, 'invalid jwt'),
    );
    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'did:plc:abc123',
      username: 'asad289.bsky.social',
      accessToken: 'expired-jwt',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('invalid jwt');
      expect(result.quotaCostUsed).toBe(0);
    }
  });

  it('fetchPostMetrics returns not_found when no platformPostId', async () => {
    const result = await adapter.fetchPostMetrics({
      accessToken: 'jwt',
    } as any);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('fetchPostMetrics maps likeCount/replyCount/repostCount', async () => {
    const atUri = 'at://did:plc:abc/app.bsky.feed.post/rkey1';
    mockClient.getPostThread.mockResolvedValue({
      thread: {
        post: {
          uri: atUri,
          cid: 'cid-xyz',
          likeCount: 15,
          replyCount: 3,
          repostCount: 7,
          indexedAt: '2024-01-01T12:00:00Z',
          author: { did: 'did:plc:abc', handle: 'test.bsky.social' },
          record: { text: 'hello world', createdAt: '2024-01-01T12:00:00Z' },
        },
      },
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: atUri,
      accessToken: 'valid-jwt',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.likesCount).toBe(15);
      expect(result.data.commentsCount).toBe(3);
      expect(result.data.sharesCount).toBe(7);
      expect(result.data.impressionsCount).toBeNull();
      expect(result.data.reachCount).toBeNull();
    }
  });
});
