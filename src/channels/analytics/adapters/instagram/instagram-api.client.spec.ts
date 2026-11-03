import { InstagramApiClient, InstagramApiError } from './instagram-api.client';

describe('InstagramApiClient', () => {
  const mockFetch = jest.fn();
  let client: InstagramApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new InstagramApiClient(mockFetch as any);
  });

  it('getUser requests correct fields and returns user shape', async () => {
    const userData = {
      id: 'ig-user-123',
      username: 'testaccount',
      name: 'Test Account',
      followers_count: 12000,
      follows_count: 500,
      media_count: 150,
      biography: 'Test bio',
      website: 'https://example.com',
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => userData });

    const result = await client.getUser('ig-user-123', 'page-access-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('ig-user-123');
    expect(url).toContain('followers_count');
    expect(url).toContain('follows_count');
    expect(url).toContain('media_count');
    expect(url).toContain('username');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer page-access-token',
    });
    expect(result.followers_count).toBe(12000);
    expect(result.username).toBe('testaccount');
  });

  it('getUserMedia passes limit param and correct fields', async () => {
    const mediaData = { data: [], paging: {} };
    mockFetch.mockResolvedValue({ ok: true, json: async () => mediaData });

    await client.getUserMedia({
      igUserId: 'ig-user-123',
      accessToken: 'tok',
      limit: 10,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('ig-user-123/media');
    expect(url).toContain('limit=10');
    expect(url).toContain('like_count');
    expect(url).toContain('comments_count');
    expect(url).toContain('media_type');
  });

  it('getUserMedia defaults limit to 25 when not provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    await client.getUserMedia({ igUserId: 'ig-user-123', accessToken: 'tok' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('limit=25');
  });

  it('maps IG/Meta error code 190 to auth_failed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 190,
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
        },
      }),
    });

    await expect(
      client.getUser('ig-user-123', 'bad-token'),
    ).rejects.toMatchObject({
      code: 'auth_failed',
      status: 400,
    });
  });

  it('maps Meta rate-limit code 4 to rate_limited', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 4, message: 'Application request limit reached.' },
      }),
    });

    await expect(client.getUser('ig-user-123', 'tok')).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps HTTP 404 to not_found', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: {} }),
    });

    await expect(client.getMedia('bad-id', 'tok')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('maps HTTP 500 to transient', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: {} }),
    });

    await expect(client.getUser('ig-user-123', 'tok')).rejects.toMatchObject({
      code: 'transient',
    });
  });

  describe('asks Instagram only for live metrics', () => {
    const metricOf = async (mediaProductType: string | undefined) => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      await client.getMediaInsights('media-id', mediaProductType, 'tok');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('media-id/insights');
      return {
        url: url as string,
        metric: new URL(url).searchParams.get('metric'),
      };
    };
    const RETIRED = /impressions|plays|engagement|exits|replies|likes|comments/;

    it('feed post: views, reach, saved, shares, follows, profile_visits', async () => {
      const { url, metric } = await metricOf('FEED');
      expect(url).toContain(
        'metric=views%2Creach%2Csaved%2Cshares%2Cfollows%2Cprofile_visits',
      );
      expect(metric).not.toMatch(RETIRED);
    });

    it('reel: views, reach, saved, shares (no follows or profile_visits)', async () => {
      const { url, metric } = await metricOf('REELS');
      expect(url).toContain('metric=views%2Creach%2Csaved%2Cshares');
      expect(metric).toBe('views,reach,saved,shares');
      expect(url).not.toMatch(RETIRED);
    });

    it('story: views and reach only', async () => {
      const { metric } = await metricOf('STORY');
      expect(metric).toBe('views,reach');
    });

    it.each([undefined, 'AD', 'SOMETHING_NEW'])(
      'falls back to the feed set for product type %s',
      async (productType) => {
        const { metric } = await metricOf(productType);
        expect(metric).toBe('views,reach,saved,shares,follows,profile_visits');
      },
    );
  });

  it('getMedia also requests media_product_type', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'm' }) });

    await client.getMedia('media-id', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url).searchParams.get('fields')).toContain(
      'media_product_type',
    );
  });

  it('InstagramApiError preserves code, status, and message', () => {
    const err = new InstagramApiError('rate_limited', 429, 'Too Many Requests');
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too Many Requests');
    expect(err.name).toBe('InstagramApiError');
  });
});
