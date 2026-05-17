import type {
  LinkedInUserInfo,
  LinkedInPostsResponse,
  LinkedInSocialActions,
} from './linkedin.types';

export class LinkedInApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent' | 'access_denied',
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LinkedInApiError';
  }
}

export class LinkedInApiClient {
  private readonly baseUrl = 'https://api.linkedin.com';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUserInfo(accessToken: string): Promise<LinkedInUserInfo> {
    return this.request<LinkedInUserInfo>(`${this.baseUrl}/v2/userinfo`, accessToken);
  }

  async getMemberPosts(opts: {
    memberId: string;
    accessToken: string;
    count?: number;
  }): Promise<LinkedInPostsResponse> {
    const params = new URLSearchParams({
      q: 'author',
      author: `urn:li:person:${opts.memberId}`,
      count: String(opts.count ?? 25),
    });
    return this.request<LinkedInPostsResponse>(
      `${this.baseUrl}/rest/posts?${params}`,
      opts.accessToken,
      true,
    );
  }

  async getSocialActions(postUrn: string, accessToken: string): Promise<LinkedInSocialActions> {
    return this.request<LinkedInSocialActions>(
      `${this.baseUrl}/rest/socialActions/${encodeURIComponent(postUrn)}`,
      accessToken,
      true,
    );
  }

  private async request<T>(url: string, accessToken: string, useRestApi = false): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (useRestApi) {
      headers['LinkedIn-Version'] = '202402';
      headers['X-Restli-Protocol-Version'] = '2.0.0';
    }
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message =
        (body as any).message ?? (body as any).error_description ?? `HTTP ${res.status}`;
      throw new LinkedInApiError(this.mapCode(res.status), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  private mapCode(status: number): LinkedInApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 403) return 'access_denied';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
