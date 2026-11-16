import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { CROSS_SITE_COOKIE } from '../refresh-cookie';

/** The browser-profile id behind the A6 "new sign-in" email (spec §7.4). */
export const DEVICE_COOKIE = 'sd_device';

/** 32 random bytes in base64url, no padding. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Chrome caps a cookie's lifetime at 400 days. */
const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * The id the cookie carries, or a fresh one when the cookie is missing or not
 * one of ours. `unknown`, not `string`: cookie-parser JSON-decodes a `j:`
 * value, so the cookie can arrive as an array or an object, and a regex test
 * would coerce `['<43 chars>']` into a match.
 */
export function readOrMintDeviceId(cookie: unknown): {
  id: string;
  isNew: boolean;
} {
  if (typeof cookie === 'string' && DEVICE_ID_RE.test(cookie)) {
    return { id: cookie, isNew: false };
  }
  return { id: randomBytes(32).toString('base64url'), isNew: true };
}

/** The raw `sd_device` value of a request, whatever type cookie-parser made it. */
export function deviceCookieOf(cookies: unknown): unknown {
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  return (cookies as Record<string, unknown>)[DEVICE_COOKIE];
}

/**
 * Set after every successful sign-in, so a browser in use keeps its id past
 * the 400-day cap. The same cross-site options as the refresh cookie: a
 * stricter SameSite would drop it and send A6 on every sign-in.
 */
export function setDeviceCookie(res: Response, id: string): void {
  res.cookie(DEVICE_COOKIE, id, {
    ...CROSS_SITE_COOKIE,
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
}
