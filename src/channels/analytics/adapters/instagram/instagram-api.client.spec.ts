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

    await expect(client.getUser('ig-user-123', 'bad-token')).rejects.toMatchObject({
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

  it('getMediaInsights selects REEL metrics for REEL media type', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getMediaInsights('reel-id', 'REEL', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('reel-id/insights');
    expect(url).toContain('plays');
    expect(url).toContain('reach');
  });

  it('getMediaInsights selects IMAGE metrics for IMAGE media type', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getMediaInsights('img-id', 'IMAGE', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('img-id/insights');
    expect(url).toContain('impressions');
    expect(url).toContain('engagement');
  });

  it('getMediaInsights falls back to default metrics for unknown media type', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getMediaInsights('media-id', 'UNKNOWN_TYPE', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('impressions');
    expect(url).toContain('reach');
    expect(url).toContain('engagement');
    expect(url).toContain('saved');
  });

  it('InstagramApiError preserves code, status, and message', () => {
    const err = new InstagramApiError('rate_limited', 429, 'Too Many Requests');
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too Many Requests');
    expect(err.name).toBe('InstagramApiError');
  });
});
