import type { YouTubeAnalyticsQueryResponse } from './youtube.types';
import { YouTubeApiError } from './youtube-data-api.client';

export interface VideoMetricsRow {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTimeMinutes: number;
  averageViewDurationSeconds: number;
}

/** YouTube Analytics API v2 — requires yt-analytics.readonly OAuth scope. */
export class YouTubeAnalyticsApiClient {
  private readonly baseUrl = 'https://youtubeanalytics.googleapis.com/v2';
  private readonly metricNames = ['views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched', 'averageViewDuration'];

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getVideoMetrics(opts: {
    videoId: string;
    accessToken: string;
    startDate: string;
    endDate: string;
  }): Promise<VideoMetricsRow | null> {
    const params = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: opts.startDate,
      endDate: opts.endDate,
      metrics: this.metricNames.join(','),
      filters: `video==${opts.videoId}`,
    });

    const res = await this.fetchImpl(`${this.baseUrl}/reports?${params}`, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      throw new YouTubeApiError(this.mapCode(res.status, message), res.status, message);
    }
    const data = (await res.json()) as YouTubeAnalyticsQueryResponse;
    const row = data.rows?.[0];
    if (!row) return null;
    return {
      views: Number(row[0] ?? 0),
      likes: Number(row[1] ?? 0),
      comments: Number(row[2] ?? 0),
      shares: Number(row[3] ?? 0),
      watchTimeMinutes: Number(row[4] ?? 0),
      averageViewDurationSeconds: Number(row[5] ?? 0),
    };
  }

  private mapCode(status: number, message: string): YouTubeApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 403 && /quota/i.test(message)) return 'rate_limited';
    if (status === 403) return 'auth_failed';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
