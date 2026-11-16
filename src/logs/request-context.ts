import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Request ids. Every HTTP request gets one: the X-Request-Id response header
 * carries it, every error body names it (AllExceptionsFilter) and every
 * error_logs row written while the request runs stores it. A user pastes the
 * id from an error toast ("Copy error ID") to support, and an admin finds the
 * exact rows with GET /admin/logs?requestId=.
 *
 * Two layers, because AsyncLocalStorage loses its context through
 * body-parser (the body's stream events fire in the socket's async context,
 * not the request's):
 *   1. requestIdMiddleware - plain express, installed first in main.ts, before
 *      every parser and route: picks the id and sets the response header, so
 *      even a request that dies in a parser answers with one.
 *   2. requestContextMiddleware - Nest middleware (LogsModule), which Nest
 *      installs after its body parsers: opens the AsyncLocalStorage scope that
 *      guards, handlers, the logger and the exception filter run inside.
 * Both go through resolveRequestId, which is idempotent: the second layer
 * reuses the id the first one chose.
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by resolveRequestId; see request-context.ts. */
    requestId?: string;
  }
}

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Our own format is req_ + 24 hex; accept a little wider (a proxy or a client
// of ours may mint its own) but bounded, and never anything but [A-Za-z0-9].
const OWN_RE = /^req_[A-Za-z0-9]{16,64}$/;

/** A request id we are willing to echo into a header, a body and a log row. */
export function isWellFormedRequestId(value: string): boolean {
  return UUID_RE.test(value) || OWN_RE.test(value);
}

export function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

/**
 * The request's id: the one already chosen for it, else a well-formed incoming
 * X-Request-Id, else a new one. Stores it on `req.requestId` and sets the
 * response header the first time.
 */
export function resolveRequestId(req: Request, res: Response): string {
  if (req.requestId) return req.requestId;
  const incoming = req.headers?.['x-request-id'];
  const id =
    typeof incoming === 'string' && isWellFormedRequestId(incoming)
      ? incoming
      : generateRequestId();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Layer 1 (main.ts): id + header, before anything else runs. */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  resolveRequestId(req, res);
  next();
}

/** Layer 2 (LogsModule): the AsyncLocalStorage scope for the rest of the request. */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req, res);
  storage.run({ requestId }, next);
}

/** The id of the HTTP request this code is running for, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
