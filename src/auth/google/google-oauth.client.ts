import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readIdTokenClaims, type GoogleClaims } from './google-claims';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Talks to Google for sign-in only. Deliberately its own OAuth client
 * (GOOGLE_AUTH_*), not the YouTube one: the sign-in consent screen should ask
 * for openid/email/profile and nothing that sounds like channel access.
 */
@Injectable()
export class GoogleOAuthClient {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.clientId() && this.clientSecret() && this.redirectUri(),
    );
  }

  buildAuthUrl(state: string, codeChallenge: string): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', this.clientId());
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Lets someone signed into two Google accounts pick the right one instead
    // of being silently signed in as whichever was last used.
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  /** Trades the authorization code for the person's verified claims. */
  async exchangeForClaims(
    code: string,
    codeVerifier: string,
  ): Promise<GoogleClaims> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      // A hung Google must not leave the sign-in popup hanging; the callback's
      // catch turns the abort into GOOGLE_ERROR.
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google token endpoint answered ${res.status}`);
    }

    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token)
      throw new Error('Google token response had no id_token');

    return readIdTokenClaims(
      body.id_token,
      this.clientId(),
      Math.floor(Date.now() / 1000),
    );
  }

  private clientId(): string {
    return this.config.get<string>('GOOGLE_AUTH_CLIENT_ID') ?? '';
  }

  private clientSecret(): string {
    return this.config.get<string>('GOOGLE_AUTH_CLIENT_SECRET') ?? '';
  }

  private redirectUri(): string {
    return this.config.get<string>('GOOGLE_AUTH_REDIRECT_URI') ?? '';
  }
}
