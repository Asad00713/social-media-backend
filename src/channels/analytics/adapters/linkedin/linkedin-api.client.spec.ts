import { LinkedInApiClient, LinkedInApiError } from './linkedin-api.client';

describe('LinkedInApiClient', () => {
  const mockFetch = jest.fn();
  let client: LinkedInApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new LinkedInApiClient(mockFetch as any);
  });

  it('getUserInfo requests /v2/userinfo and returns correct shape', async () => {
    const userInfo = {
      sub: 'abc123',
      name: 'Jane Doe',
      given_name: 'Jane',
      family_name: 'Doe',
      picture: 'https://media.licdn.com/pic.jpg',
      email: 'jane@example.com',
      email_verified: true,
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => userInfo });

    const result = await client.getUserInfo('access-token-123');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/v2/userinfo');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-token-123',
    });
    // getUserInfo does NOT use REST API headers
    expect((init as RequestInit).headers).not.toMatchObject({
      'LinkedIn-Version': expect.any(String),
    });
    expect(result.sub).toBe('abc123');
    expect(result.name).toBe('Jane Doe');
    expect(result.email).toBe('jane@example.com');
  });

  it('getMemberPosts sends REST API headers and correct author param', async () => {
    const postsResponse = {
      paging: { count: 10, start: 0 },
      elements: [
        {
          id: 'urn:li:share:12345',
          author: 'urn:li:person:abc123',
          commentary: 'Hello LinkedIn',
          publishedAt: 1716000000000,
          visibility: 'PUBLIC',
          lifecycleState: 'PUBLISHED',
        },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => postsResponse });

    const result = await client.getMemberPosts({
      memberId: 'abc123',
      accessToken: 'access-token-456',
      count: 10,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/rest/posts');
    expect(url).toContain('q=author');
    expect(url).toContain('urn%3Ali%3Aperson%3Aabc123');
    expect(url).toContain('count=10');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-token-456',
      'LinkedIn-Version': '202402',
      'X-Restli-Protocol-Version': '2.0.0',
    });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].id).toBe('urn:li:share:12345');
  });

  it('getMemberPosts defaults count to 25 when not provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) });

    await client.getMemberPosts({ memberId: 'abc123', accessToken: 'tok' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('count=25');
  });

  it('HTTP 403 maps to access_denied code', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden — insufficient permissions' }),
    });

    await expect(
      client.getMemberPosts({ memberId: 'abc123', accessToken: 'tok' }),
    ).rejects.toMatchObject({
      code: 'access_denied',
      status: 403,
    });
  });

  it('HTTP 401 maps to auth_failed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    });

    await expect(client.getUserInfo('bad-token')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 401,
    });
  });

  it('HTTP 429 maps to rate_limited', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'Too Many Requests' }),
    });

    await expect(client.getUserInfo('tok')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('HTTP 404 maps to not_found', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not Found' }),
    });

    await expect(
      client.getSocialActions('urn:li:share:99999', 'tok'),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('HTTP 500 maps to transient', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' }),
    });

    await expect(client.getUserInfo('tok')).rejects.toMatchObject({
      code: 'transient',
      status: 503,
    });
  });

  it('LinkedInApiError preserves code, status, message and name', () => {
    const err = new LinkedInApiError('access_denied', 403, 'Forbidden');
    expect(err.code).toBe('access_denied');
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
    expect(err.name).toBe('LinkedInApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('getSocialActions URL-encodes the post URN and sends REST headers', async () => {
    const socialActions = {
      likesSummary: { aggregatedTotalLikes: 42 },
      commentsSummary: { aggregatedTotalComments: 7 },
      shareStatistics: { shareCount: 3 },
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => socialActions });

    const postUrn = 'urn:li:share:12345';
    const result = await client.getSocialActions(postUrn, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain(encodeURIComponent(postUrn));
    expect((init as RequestInit).headers).toMatchObject({
      'LinkedIn-Version': '202402',
      'X-Restli-Protocol-Version': '2.0.0',
    });
    expect(result.likesSummary?.aggregatedTotalLikes).toBe(42);
    expect(result.commentsSummary?.aggregatedTotalComments).toBe(7);
  });
});
