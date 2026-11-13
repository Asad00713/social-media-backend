import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard that buckets by the visitor, not by the proxy in front of us.
 *
 * The app does not set `trust proxy`, and in production it runs behind a
 * reverse proxy, so `req.ip` is the proxy address for every visitor and one
 * shared bucket would 429 real clients. This uses the first `X-Forwarded-For`
 * hop instead, falling back to `req.ip`. Scoped to the public connect-link
 * controller on purpose; the app-wide setting is not changed here.
 */
@Injectable()
export class ForwardedForThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const headers = req.headers as Record<
      string,
      string | string[] | undefined
    >;
    const header = headers?.['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(',')[0]?.trim();
    return Promise.resolve(first || (req.ip as string));
  }
}
