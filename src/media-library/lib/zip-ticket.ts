import { createHmac, timingSafeEqual } from 'crypto';

/**
 * A folder zip is downloaded by a browser navigation, which cannot carry the
 * in-memory bearer token. The bearer-gated `zip-ticket` route mints a short
 * HMAC ticket bound to one workspace, folder and user; the bearer-less
 * download route accepts only that.
 */
export const ZIP_TICKET_TTL_MS = 5 * 60 * 1000;

/** `openssl rand -hex 32` gives 64 characters; anything under 32 is a mistake. */
export const ZIP_TICKET_SECRET_MIN_LENGTH = 32;

export interface ZipTicketPayload {
  workspaceId: string;
  categoryId: string;
  userId: string;
  exp: number /* epoch ms */;
}

/**
 * `LIBRARY_ZIP_TICKET_SECRET`, or `null` when it is unset or too short to be a
 * real key. Callers fail closed on `null`: nothing is ever signed with an
 * empty or guessable key.
 */
export function readZipTicketSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = env.LIBRARY_ZIP_TICKET_SECRET?.trim() ?? '';
  return secret.length >= ZIP_TICKET_SECRET_MIN_LENGTH ? secret : null;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signZipTicket(
  p: Omit<ZipTicketPayload, 'exp'>,
  secret: string,
  now: Date,
): { ticket: string; expiresAt: string } {
  if (!secret)
    throw new Error('Refusing to sign a zip ticket with an empty key');
  const exp = now.getTime() + ZIP_TICKET_TTL_MS;
  const payload: ZipTicketPayload = {
    workspaceId: p.workspaceId,
    categoryId: p.categoryId,
    userId: p.userId,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    ticket: `${body}.${sign(body, secret)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

function isPayload(v: unknown): v is ZipTicketPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.workspaceId === 'string' &&
    typeof p.categoryId === 'string' &&
    typeof p.userId === 'string' &&
    typeof p.exp === 'number' &&
    Number.isFinite(p.exp)
  );
}

/**
 * The payload of a ticket this secret signed that has not expired, else
 * `null` (malformed input, a bad signature, or `now` past `exp`).
 */
export function verifyZipTicket(
  ticket: string,
  secret: string,
  now: Date,
): ZipTicketPayload | null {
  if (!secret || typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  // The signature is compared as the exact string we would have produced, so
  // base64url's lenient decoding can't make two spellings verify.
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  if (now.getTime() > payload.exp) return null;
  return {
    workspaceId: payload.workspaceId,
    categoryId: payload.categoryId,
    userId: payload.userId,
    exp: payload.exp,
  };
}
