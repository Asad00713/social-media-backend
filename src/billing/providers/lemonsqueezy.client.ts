import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

const BASE = 'https://api.lemonsqueezy.com/v1/';

/**
 * Thin HTTP client for the Lemon Squeezy API.
 *
 * Separate from the adapter so the adapter's fan-out logic can be tested
 * without network access, and so the JSON:API content types and auth header
 * are stated once.
 */
@Injectable()
export class LemonSqueezyClient {
  private readonly logger = new Logger(LemonSqueezyClient.name);

  private key(): string {
    const key = process.env.LEMONSQUEEZY_API_KEY;
    if (!key) {
      throw new InternalServerErrorException(
        'LEMONSQUEEZY_API_KEY is not set; billing cannot reach the provider.',
      );
    }
    return key;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${this.key()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const detail =
        (parsed as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ??
        `HTTP ${res.status}`;

      // Keys expire ONE YEAR after creation and the failure is silent and
      // total, so 401 gets its own message naming the variable to check.
      if (res.status === 401) {
        throw new InternalServerErrorException(
          `Lemon Squeezy rejected the credentials (${detail}). ` +
            `LEMONSQUEEZY_API_KEY may have expired — keys last one year.`,
        );
      }

      throw new InternalServerErrorException(
        `Lemon Squeezy ${method} ${path} failed: ${detail}`,
      );
    }

    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
