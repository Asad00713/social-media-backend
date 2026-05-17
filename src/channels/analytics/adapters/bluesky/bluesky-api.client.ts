import type {
  BlueskyProfile,
  BlueskyFeedResponse,
  BlueskyPostThreadResponse,
  BlueskySession,
} from './bluesky.types';

export class BlueskyApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper around AT Protocol (Bluesky) xrpc endpoints. Constructor takes
 * a fetch impl so tests can inject a mock. Production uses global fetch.
 * No quota tracking needed — Bluesky has no enforced rate limits.
 */
export class BlueskyApiClient {
  private readonly baseUrl = 'https://bsky.social/xrpc';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async createSession(identifier: string, password: string): Promise<BlueskySession> {
    const res = await this.fetchImpl(`${this.baseUrl}/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new BlueskyApiError(this.mapCode(res.status), res.status, (body as any).message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<BlueskySession>;
  }

  async refreshSession(refreshJwt: string): Promise<BlueskySession> {
    const res = await this.fetchImpl(`${this.baseUrl}/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshJwt}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new BlueskyApiError(this.mapCode(res.status), res.status, (body as any).message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<BlueskySession>;
  }

  async getProfile(actor: string, accessJwt: string): Promise<BlueskyProfile> {
    return this.request<BlueskyProfile>(
      `${this.baseUrl}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
      accessJwt,
    );
  }

  async getAuthorFeed(opts: {
    actor: string;
    accessJwt: string;
    limit?: number;
    cursor?: string;
  }): Promise<BlueskyFeedResponse> {
    const params = new URLSearchParams({ actor: opts.actor, limit: String(opts.limit ?? 50) });
    if (opts.cursor) params.set('cursor', opts.cursor);
    return this.request<BlueskyFeedResponse>(
      `${this.baseUrl}/app.bsky.feed.getAuthorFeed?${params}`,
      opts.accessJwt,
    );
  }

  async getPostThread(atUri: string, accessJwt: string): Promise<BlueskyPostThreadResponse> {
    return this.request<BlueskyPostThreadResponse>(
      `${this.baseUrl}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0&parentHeight=0`,
      accessJwt,
    );
  }

  private async request<T>(url: string, accessJwt: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = (body as any).message ?? `HTTP ${res.status}`;
      const errorName = (body as any).error;
      throw new BlueskyApiError(this.mapCode(res.status, errorName, message), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  private mapCode(status: number, errorName?: string, message?: string): BlueskyApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    // Bluesky returns HTTP 400 with error name like 'ExpiredToken' / 'InvalidToken' / 'AuthRequired'
    if (status === 400) {
      const e = (errorName ?? '').toLowerCase();
      const m = (message ?? '').toLowerCase();
      if (e.includes('token') || e === 'authrequired' || m.includes('token has expired') || m.includes('invalid token')) {
        return 'auth_failed';
      }
    }
    return 'permanent';
  }
}
