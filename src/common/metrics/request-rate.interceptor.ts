import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequestRateService } from './request-rate.service';

/** Request fields this reads. Narrow on purpose: nothing here touches a body,
 *  a header, or anything that could carry a secret. */
type RateRequest = Partial<Request> & {
  route?: { path?: string };
  params?: Record<string, string>;
};

/**
 * Counts every request, refuses none.
 *
 * ## Why an interceptor and not a guard
 *
 * A guard can veto a request, which is precisely what this phase must not do.
 * An interceptor cannot: it observes. That is the whole point — the measurement
 * has to be impossible to confuse with enforcement, including by someone
 * reading it later.
 *
 * ## Why the ROUTE PATTERN, not the URL
 *
 * `req.route.path` is the Express pattern (`/posts/:id`), not the filled-in
 * path — measured, not assumed. That matters twice over:
 *
 *  - **bounded keys**: 774 routes produce at most 774 keys a minute, where
 *    URLs would produce one per post id, forever;
 *  - **no identifiers in Redis**: a URL can carry a token, an email in a query
 *    string, a workspace slug. A pattern carries none of it by construction.
 *
 * The workspace id is read from `req.params`, which is the only place it ever
 * arrives — every workspace route spells it `:workspaceId` / `:wsId` / `:wid`
 * (the shapes `every-workspace-route-guarded.spec.ts` already matches on).
 *
 * ## It cannot fail a request
 *
 * `record()` is fired without awaiting and swallows its own errors, so a Redis
 * outage degrades to "no metrics" rather than to a 500 on a customer's
 * request. The next() call is returned untouched.
 */
@Injectable()
export class RequestRateInterceptor implements NestInterceptor {
  constructor(private readonly rate: RequestRateService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    // Only HTTP. A BullMQ job or an SSE heartbeat is not a request a rate
    // limit would ever apply to, so counting them would skew the very
    // distribution this exists to measure.
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<RateRequest>();
    const route = req.route?.path;

    // No matched route means a 404: there is no endpoint to attribute it to,
    // and counting it would make unmatched junk look like real traffic.
    if (typeof route === 'string' && route.length > 0) {
      this.rate.record({ workspaceId: workspaceIdOf(req), route });
    }

    return next.handle();
  }
}

/** The workspace a request is scoped to, if any. */
export function workspaceIdOf(req: {
  params?: Record<string, string>;
}): string | undefined {
  const params = req.params ?? {};
  // The three spellings in use across the app. Kept in sync with the
  // WS_PARAM regex in every-workspace-route-guarded.spec.ts.
  const raw = params.workspaceId ?? params.wsId ?? params.wid;
  const id = raw?.trim();
  return id ? id : undefined;
}
