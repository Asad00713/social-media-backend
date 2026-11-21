import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { requestClientIp } from '../utils/request-client-ip';

/** "in 45s" / "in 3 minutes" — a wait a person can act on. */
function humanWait(seconds: number): string {
  if (seconds <= 90) return `${Math.max(1, Math.ceil(seconds))}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * ThrottlerGuard that buckets by the visitor, not by the proxy in front of us.
 *
 * The app does not set `trust proxy`, and in production it runs behind
 * Railway's edge, so `req.ip` is the proxy address for every visitor and one
 * shared bucket would 429 real clients. Which header to believe matters: the
 * LEFTMOST `X-Forwarded-For` entry is whatever the caller sent, so rotating it
 * would dodge the limit. Order used here:
 *   1. `X-Real-IP`: Railway's edge sets/overwrites it with the client's remote
 *      IP on every request (Railway staff:
 *      https://station.railway.com/questions/which-header-should-i-rely-on-for-real-c-d78a6f96).
 *   2. the RIGHTMOST non-empty `X-Forwarded-For` entry: the edge appends the
 *      address it saw, so only the last hop is not client-controlled.
 *   3. `req.ip`.
 *
 * Applied per controller, never as an APP_GUARD: the app-wide
 * `ThrottlerModule.forRoot` default stays off on purpose (see the comment at
 * its registration in `app.module.ts`), so only a route carrying an explicit
 * `@Throttle` is limited.
 *
 * It lives in `common/` because two unrelated surfaces need the same tracker:
 * the public connect-link controller and the unauthenticated auth routes.
 * Both face the open internet with no JWT to bucket by, which is exactly when
 * the proxy problem above bites.
 *
 * ## It also throws something a UI can show
 *
 * The default throttler message is the literal string
 * `"ThrottlerException: Too Many Requests"`, and the frontend puts a failed
 * request's `message` straight into a toast — so a limited sign-in told the
 * person "ThrottlerException: Too Many Requests". That is the same class of
 * bug the `admin/challenge` limit already caused once, where a 429 reached the
 * user as "could not reach the server".
 *
 * So the body carries a sentence, a `code`, and `retryAfterSeconds` — the last
 * one because the frontend's `resendCooldownFrom` already reads exactly that
 * field to drive its countdown.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    // The address order (X-Real-IP, rightmost X-Forwarded-For, req.ip) lives
    // in requestClientIp, shared with the session issuer.
    // An unusable header falls back to the raw req.ip as the bucket key, as
    // before (the key only needs to be stable, not a valid address).
    return Promise.resolve(requestClientIp(req) ?? (req.ip as string));
  }

  /**
   * Replaces the whole exception, not just its message.
   *
   * `getErrorMessage` alone would fix the sentence but still send a body with
   * no machine-readable tag and no wait, leaving every client to parse prose.
   */
  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Already in seconds, and the same value the guard puts in `Retry-After`.
    const retryAfterSeconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: `Too many attempts. Try again in ${humanWait(retryAfterSeconds)}.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
