import { FacebookApiClient, FacebookApiError } from './facebook-api.client';

describe('FacebookApiClient', () => {
  const mockFetch = jest.fn();
  let client: FacebookApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new FacebookApiClient(mockFetch as any);
  });

  it('getPage requests correct fields and returns page shape', async () => {
    const pageData = {
      id: '123456',
      name: 'Test Page',
      fan_count: 5000,
      followers_count: 4800,
      category: 'Software',
      verification_status: 'not_verified',
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => pageData });

    const result = await client.getPage('123456', 'page-access-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('123456');
    expect(url).toContain('fan_count');
    expect(url).toContain('followers_count');
    expect(decodeURIComponent(url)).toContain('picture.type(large)');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer page-access-token',
    });
    expect(result.fan_count).toBe(5000);
    expect(result.name).toBe('Test Page');
  });

  it('getPagePosts passes limit and since params', async () => {
    const postsData = { data: [], paging: {} };
    mockFetch.mockResolvedValue({ ok: true, json: async () => postsData });

    await client.getPagePosts({
      pageId: 'page-id',
      accessToken: 'tok',
      limit: 10,
      since: 1700000000,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('page-id/posts');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1700000000');
    expect(decodeURIComponent(url)).toContain('reactions.summary(true)');
  });

  it('maps FB error code 190 to auth_failed', async () => {
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

    await expect(client.getPage('123456', 'bad-token')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 400,
    });
  });

  it('maps FB rate-limit code 4 to rate_limited', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 4, message: 'Application request limit reached.' },
      }),
    });

    await expect(client.getPage('123456', 'tok')).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps HTTP 404 to not_found', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: {} }),
    });

    await expect(client.getPost('bad-id', 'tok')).rejects.toMatchObject({
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

    await expect(client.getPage('123456', 'tok')).rejects.toMatchObject({
      code: 'transient',
    });
  });

  it('getPostInsights requests correct metrics', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getPostInsights('post-id', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('post-id/insights');
    expect(url).toContain('post_impressions');
    expect(url).toContain('post_impressions_unique');
    expect(url).toContain('post_engaged_users');
  });
});
