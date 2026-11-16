import type { Response } from 'express';

/**
 * The options every sign-in cookie shares. The frontend and the API are on
 * different sites, so SameSite=None and Secure are both required; anything
 * stricter and the browser drops the cookie on the cross-site request.
 */
export const CROSS_SITE_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
} as const;

/**
 * The refresh cookie exactly as AuthController sets it on login and register.
 */
export function setRefreshCookie(response: Response, token: string): void {
  response.cookie('refreshToken', token, {
    ...CROSS_SITE_COOKIE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
