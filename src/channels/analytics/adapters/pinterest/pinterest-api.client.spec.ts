import { PinterestApiClient, PinterestApiError } from './pinterest-api.client';

describe('PinterestApiClient', () => {
  const mockFetch = jest.fn();
  let client: PinterestApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new PinterestApiClient(mockFetch as any);
  });

  it('getUserAccount requests /user_account and returns correct shape', async () => {
    const userData = {
      username: 'pintestuser',
      account_type: 'BUSINESS',
      profile_image: 'https://i.pinimg.com/pic.jpg',
      website_url: 'https://example.com',
      about: 'A great business',
      business_name: 'Test Co',
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => userData });

    const result = await client.getUserAccount('access-token-123');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/user_account');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer access-token-123',
    });
    expect(result.username).toBe('pintestuser');
    expect(result.account_type).toBe('BUSINESS');
    expect(result.business_name).toBe('Test Co');
  });

  it('getPins passes page_size param and returns items array', async () => {
    const pinsData = {
      items: [
        {
          id: 'pin-1',
          created_at: '2026-05-01T10:00:00Z',
          title: 'Test Pin',
          description: 'A great pin',
          board_id: 'board-1',
          media: { media_type: 'image', images: { '600x': { url: 'https://i.pinimg.com/600x/img.jpg' } } },
        },
      ],
      bookmark: 'next-cursor',
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => pinsData });

    const result = await client.getPins({ accessToken: 'tok', pageSize: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/pins');
    expect(url).toContain('page_size=10');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('pin-1');
    expect(result.bookmark).toBe('next-cursor');
  });

  it('getPins defaults page_size to 25 when not provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });

    await client.getPins({ accessToken: 'tok' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('page_size=25');
  });

  it('maps HTTP 401 to auth_failed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    });

    await expect(client.getUserAccount('bad-token')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 401,
    });
  });

  it('maps HTTP 403 to auth_failed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' }),
    });

    await expect(client.getUserAccount('bad-token')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 403,
    });
  });

  it('maps HTTP 429 to rate_limited', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'Too Many Requests' }),
    });

    await expect(client.getPins({ accessToken: 'tok' })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('maps HTTP 404 to not_found', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Pin not found' }),
    });

    await expect(client.getPin('bad-pin-id', 'tok')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('maps HTTP 500 to transient', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' }),
    });

    await expect(client.getUserAccount('tok')).rejects.toMatchObject({
      code: 'transient',
      status: 503,
    });
  });

  it('maps non-500, non-auth, non-rate, non-404 to permanent', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Bad request' }),
    });

    await expect(client.getUserAccount('tok')).rejects.toMatchObject({
      code: 'permanent',
      status: 400,
    });
  });

  it('PinterestApiError preserves code, status, message and name', () => {
    const err = new PinterestApiError('rate_limited', 429, 'Too Many Requests');
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too Many Requests');
    expect(err.name).toBe('PinterestApiError');
  });

  it('getUserAnalytics builds correct query params with metric_types', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ all: { summary_metrics: { FOLLOWER_COUNT: 5000 } } }),
    });

    await client.getUserAnalytics({
      accessToken: 'tok',
      startDate: '2026-04-17',
      endDate: '2026-05-17',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/user_account/analytics');
    expect(url).toContain('start_date=2026-04-17');
    expect(url).toContain('end_date=2026-05-17');
    expect(url).toContain('FOLLOWER_COUNT');
    expect(url).toContain('IMPRESSION');
    expect(url).toContain('SAVE');
  });

  it('getPinAnalytics builds correct URL with pinId and date params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ all: { summary_metrics: { IMPRESSION: 1500 } } }),
    });

    await client.getPinAnalytics({
      pinId: 'pin-abc123',
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/pins/pin-abc123/analytics');
    expect(url).toContain('start_date=2026-05-01');
    expect(url).toContain('PIN_CLICK');
    expect(url).toContain('OUTBOUND_CLICK');
  });
});
