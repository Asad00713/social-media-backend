import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

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
      json: async () => ({ columnHeaders: [], rows: [[100, 10, 5, 2, 200, 30]] }),
    });
    const result = await client.getVideoMetrics({
      videoId: 'abc',
      accessToken: 'tok',
      startDate: '2026-05-01',
      endDate: '2026-05-17',
    });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('ids=channel%3D%3DMINE');
    expect(url).toContain('metrics=views%2Clikes%2Ccomments%2Cshares%2CestimatedMinutesWatched%2CaverageViewDuration');
    expect(url).toContain('filters=video%3D%3Dabc');
    expect(url).toContain('startDate=2026-05-01');
    expect(url).toContain('endDate=2026-05-17');
    expect(result).toEqual({
      views: 100, likes: 10, comments: 5, shares: 2,
      watchTimeMinutes: 200, averageViewDurationSeconds: 30,
    });
  });

  it('returns null when no rows in response', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ columnHeaders: [] }) });
    const result = await client.getVideoMetrics({
      videoId: 'abc', accessToken: 'tok',
      startDate: '2026-05-01', endDate: '2026-05-17',
    });
    expect(result).toBeNull();
  });
});
