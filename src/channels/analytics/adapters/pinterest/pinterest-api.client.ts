import type {
  PinterestUserAccount,
  PinterestAnalyticsResponse,
  PinterestPin,
  PinterestPinsListResponse,
  PinterestPinAnalyticsResponse,
} from './pinterest.types';

export class PinterestApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PinterestApiError';
  }
}

export class PinterestApiClient {
  private readonly baseUrl = 'https://api.pinterest.com/v5';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUserAccount(accessToken: string): Promise<PinterestUserAccount> {
    return this.request<PinterestUserAccount>(`${this.baseUrl}/user_account`, accessToken);
  }

  async getUserAnalytics(opts: {
    accessToken: string;
    startDate: string;
    endDate: string;
  }): Promise<PinterestAnalyticsResponse> {
    const params = new URLSearchParams({
      start_date: opts.startDate,
      end_date: opts.endDate,
      metric_types: 'FOLLOWER_COUNT,IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,ENGAGEMENT',
    });
    return this.request<PinterestAnalyticsResponse>(
      `${this.baseUrl}/user_account/analytics?${params}`,
      opts.accessToken,
    );
  }

  async getPins(opts: {
    accessToken: string;
    pageSize?: number;
    bookmark?: string;
  }): Promise<PinterestPinsListResponse> {
    const params = new URLSearchParams({ page_size: String(opts.pageSize ?? 25) });
    if (opts.bookmark) params.set('bookmark', opts.bookmark);
    return this.request<PinterestPinsListResponse>(
      `${this.baseUrl}/pins?${params}`,
      opts.accessToken,
    );
  }

  async getPin(pinId: string, accessToken: string): Promise<PinterestPin> {
    return this.request<PinterestPin>(`${this.baseUrl}/pins/${pinId}`, accessToken);
  }

  async getPinAnalytics(opts: {
    pinId: string;
    accessToken: string;
    startDate: string;
    endDate: string;
  }): Promise<PinterestPinAnalyticsResponse> {
    const params = new URLSearchParams({
      start_date: opts.startDate,
      end_date: opts.endDate,
      metric_types: 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,ENGAGEMENT',
    });
    return this.request<PinterestPinAnalyticsResponse>(
      `${this.baseUrl}/pins/${opts.pinId}/analytics?${params}`,
      opts.accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = (body as any).message ?? (body as any).error ?? `HTTP ${res.status}`;
      throw new PinterestApiError(this.mapCode(res.status), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  private mapCode(status: number): PinterestApiError['code'] {
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
