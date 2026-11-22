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
 * Refresh JWT and cookie lifetime (spec §7.1). The session row enforces the
 * real limit: 30 days without use, pushed out on every refresh.
 */
export const REFRESH_TTL_DAYS = 30;

/**
 * The refresh cookie. Set only by SessionIssuer (the guard spec fails on any
 * other `cookie('refreshToken', ...)`), so every sign-in shares one lifetime.
 */
export function setRefreshCookie(response: Response, token: string): void {
  response.cookie('refreshToken', token, {
    ...CROSS_SITE_COOKIE,
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

/**
 * Clears the refresh cookie, with the options it was set with (a browser only
 * drops a cookie whose attributes match). Used by logout, and by the account
 * delete, which cannot rely on a later /auth/logout: the access token is
 * refused (ACCOUNT_DELETED) the moment the account is gone.
 */
export function clearRefreshCookie(response: Response): void {
  response.clearCookie('refreshToken', CROSS_SITE_COOKIE);
}
