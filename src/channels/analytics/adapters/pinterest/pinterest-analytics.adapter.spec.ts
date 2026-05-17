import { PinterestAnalyticsAdapter } from './pinterest-analytics.adapter';
import { PinterestApiClient, PinterestApiError } from './pinterest-api.client';

describe('PinterestAnalyticsAdapter', () => {
  const client = {
    getUserAccount: jest.fn(),
    getUserAnalytics: jest.fn(),
    getPins: jest.fn(),
    getPin: jest.fn(),
    getPinAnalytics: jest.fn(),
  };
  let adapter: PinterestAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new PinterestAnalyticsAdapter(client as unknown as PinterestApiClient);
  });

  it('exposes platform=pinterest with correct capabilities and vocabulary', () => {
    expect(adapter.platform).toBe('pinterest');
    expect(adapter.capabilities.vocabulary.follower).toBe('followers');
    expect(adapter.capabilities.vocabulary.share).toBe('save');
    expect(adapter.capabilities.vocabulary.post).toBe('pin');
    expect(adapter.capabilities.hasImpressions).toBe(true);
    expect(adapter.capabilities.hasReach).toBe(false);
    expect(adapter.capabilities.hasFollowingCount).toBe(false);
    expect(adapter.capabilities.hasEphemeralContent).toBe(false);
    expect(adapter.capabilities.ephemeralTTLHours).toBeNull();
    expect(adapter.capabilities.contentTypes).toContain('pin');
    expect(adapter.capabilities.dailyQuotaBudget).toBeNull();
    expect(adapter.capabilities.dataFreshness).toBe('daily');
  });

  it('pollingProfile has pin schedule ending with final', () => {
    const pinSchedule = adapter.pollingProfile.schedulePerContentType?.pin;
    expect(pinSchedule).toBeDefined();
    expect(pinSchedule![0]).toBe('1h');
    expect(pinSchedule![pinSchedule!.length - 1]).toBe('final');
    expect(pinSchedule).toContain('7d');
    expect(pinSchedule).toContain('30d');
    expect(adapter.pollingProfile.defaultContentType).toBe('pin');
  });

  it('fetchProfileSnapshot returns success when both account and analytics succeed', async () => {
    client.getUserAccount.mockResolvedValue({
      username: 'myboard',
      account_type: 'BUSINESS',
      profile_image: 'https://i.pinimg.com/pic.jpg',
      website_url: 'https://mysite.com',
      about: 'A great board',
      business_name: 'My Co',
    });
    client.getUserAnalytics.mockResolvedValue({
      all: {
        summary_metrics: {
          FOLLOWER_COUNT: 8500,
          IMPRESSION: 120000,
          SAVE: 3200,
        },
      },
    });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'myboard',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(8500);
      expect(result.data.followingCount).toBeNull();
      expect(result.data.totalPostsCount).toBeNull();
      expect(result.data.platformMetrics.username).toBe('myboard');
      expect(result.data.platformMetrics.accountType).toBe('BUSINESS');
      expect(result.data.platformMetrics.profileImage).toBe('https://i.pinimg.com/pic.jpg');
      expect(result.data.platformMetrics.websiteUrl).toBe('https://mysite.com');
      expect(result.data.platformMetrics.businessName).toBe('My Co');
    }
  });

  it('fetchProfileSnapshot returns partial when analytics fail but account succeeds', async () => {
    client.getUserAccount.mockResolvedValue({
      username: 'myboard',
      account_type: 'PERSONAL',
    });
    client.getUserAnalytics.mockRejectedValue(
      new PinterestApiError('transient', 503, 'Service Unavailable'),
    );

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'myboard',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.followersCount).toBeNull();
      expect(result.data.platformMetrics!['username']).toBe('myboard');
      expect(result.missing).toContain('FOLLOWER_COUNT');
    }
  });

  it('fetchProfileSnapshot returns failed when account fetch fails', async () => {
    client.getUserAccount.mockRejectedValue(
      new PinterestApiError('auth_failed', 401, 'Unauthorized'),
    );
    client.getUserAnalytics.mockResolvedValue({ all: { summary_metrics: {} } });

    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'myboard',
      accessToken: 'bad-token',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toBe('Unauthorized');
    }
  });

  it('fetchPostMetrics maps pin analytics correctly with SAVE→sharesCount', async () => {
    client.getPinAnalytics.mockResolvedValue({
      all: {
        summary_metrics: {
          IMPRESSION: 15000,
          SAVE: 420,
          PIN_CLICK: 890,
          OUTBOUND_CLICK: 230,
          ENGAGEMENT: 1540,
        },
      },
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'pin-abc123',
      accessToken: 'tok',
      publishedAt: new Date('2026-05-01T10:00:00Z'),
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(15000);
      expect(result.data.sharesCount).toBe(420); // SAVE maps to sharesCount
      expect(result.data.likesCount).toBe(0); // Pinterest has no like metric
      expect(result.data.commentsCount).toBe(0); // not in analytics metric set
      expect(result.data.reachCount).toBeNull();
      expect(result.data.platformMetrics.pinClicks).toBe(890);
      expect(result.data.platformMetrics.outboundClicks).toBe(230);
      expect(result.data.platformMetrics.engagement).toBe(1540);
    }
  });

  it('fetchPostMetrics falls back to lifetime_metrics when summary_metrics absent', async () => {
    client.getPinAnalytics.mockResolvedValue({
      all: {
        lifetime_metrics: {
          IMPRESSION: 7500,
          SAVE: 200,
        },
      },
    });

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'pin-xyz',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.impressionsCount).toBe(7500);
      expect(result.data.sharesCount).toBe(200);
    }
  });

  it('fetchPostMetrics returns failed with not_found when pinId missing', async () => {
    const result = await adapter.fetchPostMetrics({
      platformPostId: '',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('fetchPostMetrics returns failed when analytics call throws', async () => {
    client.getPinAnalytics.mockRejectedValue(
      new PinterestApiError('rate_limited', 429, 'Too Many Requests'),
    );

    const result = await adapter.fetchPostMetrics({
      platformPostId: 'pin-abc',
      accessToken: 'tok',
    } as any);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
    }
  });

  it('fetchRecentPosts maps pin list and filters by since', async () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const old = new Date('2026-04-01T00:00:00Z');

    client.getPins.mockResolvedValue({
      items: [
        {
          id: 'pin-1',
          created_at: now.toISOString(),
          title: 'Spring Recipe',
          description: 'A yummy recipe',
          board_id: 'board-123',
          link: 'https://example.com/recipe',
          alt_text: 'Food photo',
          media: {
            media_type: 'image',
            images: { '600x': { url: 'https://i.pinimg.com/600x/img.jpg' } },
          },
        },
        {
          id: 'pin-2',
          created_at: old.toISOString(), // too old — should be filtered
          title: 'Old pin',
        },
      ],
      bookmark: undefined,
    });

    const since = new Date('2026-04-15T00:00:00Z');
    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'myboard', accessToken: 'tok' } as any,
      { since, limit: 25 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts).toHaveLength(1);
      const post = result.data.posts[0];
      expect(post.platformPostId).toBe('pin-1');
      expect(post.content).toBe('Spring Recipe');
      expect(post.mediaUrl).toBe('https://i.pinimg.com/600x/img.jpg');
      expect(post.metrics.likesCount).toBe(0);
      expect(post.metrics.commentsCount).toBe(0);
      expect(post.metrics.sharesCount).toBeNull();
      expect(post.metrics.impressionsCount).toBeNull();
      expect(post.metrics.platformMetrics.boardId).toBe('board-123');
      expect(post.metrics.platformMetrics.link).toBe('https://example.com/recipe');
      expect(post.metrics.platformMetrics.altText).toBe('Food photo');
    }
  });

  it('fetchRecentPosts falls back to 1200x image when 600x absent', async () => {
    client.getPins.mockResolvedValue({
      items: [
        {
          id: 'pin-3',
          created_at: new Date().toISOString(),
          title: 'High-res pin',
          media: {
            media_type: 'image',
            images: { '1200x': { url: 'https://i.pinimg.com/1200x/img.jpg' } },
          },
        },
      ],
    });

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'myboard', accessToken: 'tok' } as any,
      { since: new Date(Date.now() - 60000), limit: 25 },
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.posts[0].mediaUrl).toBe('https://i.pinimg.com/1200x/img.jpg');
    }
  });

  it('fetchRecentPosts returns failed on auth error', async () => {
    client.getPins.mockRejectedValue(
      new PinterestApiError('auth_failed', 401, 'Unauthorized'),
    );

    const result = await adapter.fetchRecentPosts(
      { platformAccountId: 'myboard', accessToken: 'bad-token' } as any,
      { since: new Date(), limit: 25 },
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('auth_failed');
    }
  });
});
