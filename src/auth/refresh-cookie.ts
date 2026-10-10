import type { Response } from 'express';

/**
 * The refresh cookie exactly as AuthController sets it on login and register.
 * Cross-origin frontend, so SameSite=None and Secure are both required.
 */
export function setRefreshCookie(response: Response, token: string): void {
  response.cookie('refreshToken', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
