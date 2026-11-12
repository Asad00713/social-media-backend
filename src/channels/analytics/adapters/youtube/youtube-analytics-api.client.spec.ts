import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';
import { YouTubeApiError } from './youtube-data-api.client';

describe('YouTubeAnalyticsApiClient', () => {
  let client: YouTubeAnalyticsApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new YouTubeAnalyticsApiClient(mockFetch as any);
  });

  it('getVideoMetrics requests correct metrics list and filters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        columnHeaders: [],
        rows: [[100, 10, 5, 2, 200, 30]],
      }),
    });
    const result = await client.getVideoMetrics({
      videoId: 'abc',
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('ids=channel%3D%3DMINE');
    expect(url).toContain(
      'metrics=views%2Clikes%2Ccomments%2Cshares%2CestimatedMinutesWatched%2CaverageViewDuration',
    );
    expect(url).toContain('filters=video%3D%3Dabc');
    expect(url).toContain('startDate=2026-05-01');
    expect(url).toContain('endDate=2026-05-17');
    expect(result).toEqual({
      views: 100,
      likes: 10,
      comments: 5,
      shares: 2,
      watchTimeMinutes: 200,
      averageViewDurationSeconds: 30,
    });
  });

  it('returns null when no rows in response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ columnHeaders: [] }),
    });
    const result = await client.getVideoMetrics({
      videoId: 'abc',
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });
    expect(result).toBeNull();
  });

  it('getViewsByCountry requests views by country and maps rows to slices', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        columnHeaders: [],
        rows: [
          ['US', 120],
          ['PK', '45'],
        ],
      }),
    });

    const result = await client.getViewsByCountry({
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });

    const [url, init] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://youtubeanalytics.googleapis.com/v2/reports',
    );
    expect(parsed.searchParams.get('ids')).toBe('channel==MINE');
    expect(parsed.searchParams.get('metrics')).toBe('views');
    expect(parsed.searchParams.get('dimensions')).toBe('country');
    expect(parsed.searchParams.get('sort')).toBe('-views');
    expect(parsed.searchParams.get('startDate')).toBe('2026-05-01');
    expect(parsed.searchParams.get('endDate')).toBe('2026-05-17');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer tok',
    });
    expect(result).toEqual([
      { key: 'US', value: 120 },
      { key: 'PK', value: 45 },
    ]);
  });

  it('getViewsByCountry returns an empty list when there are no rows', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ columnHeaders: [] }),
    });

    const result = await client.getViewsByCountry({
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });

    expect(result).toEqual([]);
  });

  it('getViewsByCountry throws YouTubeApiError on a failed response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Forbidden' } }),
    });

    const err = await client
      .getViewsByCountry({
        accessToken: 'tok',
        startDate: '2026-05-01',
        endDate: '2026-05-17',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(YouTubeApiError);
    expect(err).toMatchObject({ code: 'auth_failed', status: 403 });
  });
});
