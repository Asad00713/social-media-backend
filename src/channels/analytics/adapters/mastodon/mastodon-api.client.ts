import {
  fetchPublic,
  UnsafeUrlError,
  type PublicRequestInit,
} from '../../../../common/net/public-fetch';
import type { MastodonAccount, MastodonStatus } from './mastodon.types';

/** One HTTP request; injectable so tests can stub the network. */
type FetchLike = (url: string, init?: PublicRequestInit) => Promise<Response>;

export class MastodonApiError extends Error {
  constructor(
    public code:
      | 'rate_limited'
      | 'auth_failed'
      | 'not_found'
      | 'transient'
      | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper around the Mastodon v1 REST API. Constructor takes a fetch impl
 * so tests can inject a mock. Production uses fetchPublic: the instance URL is
 * user-supplied, so public hosts only, pinned at connect, no redirects.
 * No quota tracking — per-instance limits are generous for read-only use.
 */
export class MastodonApiClient {
  constructor(private readonly fetchImpl: FetchLike = fetchPublic) {}

  async verifyCredentials(
    instanceUrl: string,
    accessToken: string,
  ): Promise<MastodonAccount> {
    return this.request<MastodonAccount>(
      `${this.normalizeInstance(instanceUrl)}/api/v1/accounts/verify_credentials`,
      accessToken,
    );
  }

  async getAccountStatuses(opts: {
    instanceUrl: string;
    accountId: string;
    accessToken: string;
    limit?: number;
    sinceId?: string;
  }): Promise<MastodonStatus[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 40) });
    if (opts.sinceId) params.set('since_id', opts.sinceId);
    return this.request<MastodonStatus[]>(
      `${this.normalizeInstance(opts.instanceUrl)}/api/v1/accounts/${encodeURIComponent(opts.accountId)}/statuses?${params}`,
      opts.accessToken,
    );
  }

  async getStatus(opts: {
    instanceUrl: string;
    statusId: string;
    accessToken: string;
  }): Promise<MastodonStatus> {
    return this.request<MastodonStatus>(
      `${this.normalizeInstance(opts.instanceUrl)}/api/v1/statuses/${encodeURIComponent(opts.statusId)}`,
      opts.accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new MastodonApiError(
          'permanent',
          0,
          "That Mastodon server address isn't reachable from the internet.",
        );
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.error ?? body.message ?? `HTTP ${res.status}`;
      throw new MastodonApiError(this.mapCode(res.status), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  normalizeInstance(instanceUrl: string): string {
    // Accept "mastodon.social", "https://mastodon.social", "https://mastodon.social/"
    const trimmed = instanceUrl.replace(/\/$/, '');
    if (/^https?:\/\//.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  private mapCode(status: number): MastodonApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
