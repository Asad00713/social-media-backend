import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttles the unauthenticated report routes per caller. The app never sets
 * `trust proxy` (that would change `req.ip` for every route), so behind the
 * edge `req.ip` is the same for everyone. The caller is the first entry of
 * `X-Forwarded-For` instead. That entry is whatever the client sent: an edge
 * proxy that appends to the header keeps it, so a caller can pick its own
 * bucket even behind a proxy. This is a soft limit, and the ruling accepts
 * that.
 *
 * The one exception is the unsubscribe POST, which keys on its token through
 * `unsubscribeTokenTracker`: Gmail and Yahoo send RFC 8058 one-click POSTs from
 * their own servers, which would otherwise share one bucket for every list.
 */
@Injectable()
export class ReportsPublicThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const headers = req.headers as
      | Record<string, string | string[] | undefined>
      | undefined;
    const header = headers?.['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw ? raw.split(',')[0].trim() : '';
    return Promise.resolve(
      first || (req.ip as string | undefined) || 'unknown',
    );
  }
}

/**
 * `getTracker` for `POST /reports/unsubscribe/:token`: 10 a minute per token.
 * The token is unverified here, so a flood of random ones each opens a bucket
 * of its own; each costs one JWT verification and no database read.
 */
export function unsubscribeTokenTracker(req: Record<string, any>): string {
  const params = req.params as { token?: string } | undefined;
  return `unsub:${params?.token}`;
}
