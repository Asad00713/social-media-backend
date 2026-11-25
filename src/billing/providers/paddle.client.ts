import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

/**
 * Where the Paddle API lives, from the environment.
 *
 * Deliberately NOT a module constant like `lemonsqueezy.client.ts`'s `BASE`.
 * Paddle runs sandbox and live on DIFFERENT HOSTS
 * (`sandbox-api.paddle.com` vs `api.paddle.com`), so a hard-coded base is a
 * hard-coded environment — and this repo has already shipped that bug once,
 * when `PINTEREST_USE_SANDBOX=true` reached production.
 *
 * No default. A missing variable fails loudly at the first call rather than
 * quietly billing real cards from a developer's machine, or quietly billing
 * nothing in production.
 */
export const PADDLE_API_BASE_ENV = 'PADDLE_API_BASE';
export const PADDLE_API_KEY_ENV = 'PADDLE_API_KEY';

/** Sandbox and live hosts, for the setup error message and for tests. */
export const PADDLE_SANDBOX_BASE = 'https://sandbox-api.paddle.com';
export const PADDLE_LIVE_BASE = 'https://api.paddle.com';

/** A call that takes longer than this is cancelled, not left to hang. */
export const PADDLE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The API version this adapter is written against.
 *
 * Sent on every request on purpose. Paddle falls back to the ACCOUNT's
 * default version when the header is absent, and that default is whatever was
 * current when the account was created — so omitting it makes the response
 * shape a property of the account rather than of this code, and a new account
 * would silently get a different one.
 */
export const PADDLE_API_VERSION = '1';

/** Paddle's error body: `{ error: { type, code, detail, documentation_url } }`. */
interface PaddleErrorBody {
  error?: { code?: string; detail?: string; type?: string };
}

/**
 * Thin HTTP client for the Paddle Billing API.
 *
 * Separate from the adapter so the adapter's logic can be tested without
 * network access, and so the auth header, the version header and the error
 * shape are stated once.
 */
@Injectable()
export class PaddleClient {
  private readonly logger = new Logger(PaddleClient.name);

  /** The configured base, without a trailing slash. */
  base(): string {
    const raw = process.env[PADDLE_API_BASE_ENV];
    if (!raw) {
      throw new InternalServerErrorException(
        `${PADDLE_API_BASE_ENV} is not set; billing cannot reach Paddle. ` +
          `Use ${PADDLE_SANDBOX_BASE} for sandbox or ${PADDLE_LIVE_BASE} for live.`,
      );
    }
    return raw.replace(/\/+$/, '');
  }

  private key(): string {
    const key = process.env[PADDLE_API_KEY_ENV];
    if (!key) {
      throw new InternalServerErrorException(
        `${PADDLE_API_KEY_ENV} is not set; billing cannot reach Paddle.`,
      );
    }
    return key;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base()}/${path.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.key()}`,
          'Paddle-Version': PADDLE_API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PADDLE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'TimeoutError') {
        throw new InternalServerErrorException(
          `Paddle ${method} ${path} timed out after ${PADDLE_REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    }

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const error = (parsed as PaddleErrorBody)?.error;
      const detail = error?.detail ?? error?.code ?? `HTTP ${res.status}`;

      // A sandbox key against the live host (or the reverse) fails here, and
      // the host is the thing worth naming: the key looks correct because it
      // IS correct, just for the other environment.
      if (res.status === 401 || res.status === 403) {
        throw new InternalServerErrorException(
          `Paddle rejected the credentials (${detail}). ` +
            `Check that ${PADDLE_API_KEY_ENV} belongs to the environment at ${this.base()}.`,
        );
      }

      throw new InternalServerErrorException(
        `Paddle ${method} ${path} failed: ${detail}`,
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
}
