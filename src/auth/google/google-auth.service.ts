import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../../users/users.service';
import { normalizeEmail } from '../../users/normalize-email';
import { LoginActivityService } from '../services/login-activity.service';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateSecureToken,
} from '../../common/utils/encryption.util';
import { GoogleOAuthClient } from './google-oauth.client';
import {
  buildDoneUrl,
  decideGoogleSignIn,
  type GoogleAuthMode,
  type GoogleCandidate,
  type GoogleDoneStatus,
} from './google-sign-in.decision';

export const GOOGLE_STATE_COOKIE = 'g_auth';
const STATE_TTL = '10m';

interface StatePayload {
  state: string;
  verifier: string;
  mode: GoogleAuthMode;
  purpose: 'google-auth';
}

export interface GoogleCallbackResult {
  redirectUrl: string;
  session: { userId: string; email: string } | null;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly client: GoogleOAuthClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly loginActivity: LoginActivityService,
  ) {}

  start(mode: GoogleAuthMode): {
    redirectUrl: string;
    stateCookie: string | null;
  } {
    if (!this.client.isConfigured()) {
      return {
        redirectUrl: this.done('error', mode, 'GOOGLE_NOT_CONFIGURED'),
        stateCookie: null,
      };
    }

    const state = generateSecureToken(32);
    const verifier = generateCodeVerifier();
    // The state and PKCE verifier ride in a signed cookie rather than a table:
    // there is no user yet to hang a row on, and a signature is all that is
    // needed to know the callback is answering OUR redirect.
    const payload: StatePayload = {
      state,
      verifier,
      mode,
      purpose: 'google-auth',
    };
    const stateCookie = this.jwt.sign(payload, {
      secret: this.stateSecret(),
      expiresIn: STATE_TTL,
    });

    return {
      redirectUrl: this.client.buildAuthUrl(
        state,
        generateCodeChallenge(verifier),
      ),
      stateCookie,
    };
  }

  async callback(
    query: { code?: string; state?: string; error?: string },
    stateCookie: string | undefined,
    ip?: string,
  ): Promise<GoogleCallbackResult> {
    let saved: StatePayload;
    try {
      saved = this.jwt.verify<StatePayload>(stateCookie ?? '', {
        secret: this.stateSecret(),
      });
    } catch {
      // No cookie means no mode either; redirect mode is the one that works
      // whether or not this window has an opener.
      return this.fail('error', 'redirect', 'STATE_INVALID');
    }

    const mode = saved.mode;
    if (
      saved.purpose !== 'google-auth' ||
      !query.state ||
      query.state !== saved.state
    ) {
      return this.fail('error', mode, 'STATE_INVALID');
    }

    if (query.error) {
      return query.error === 'access_denied'
        ? this.fail('cancelled', mode)
        : this.fail('error', mode, 'GOOGLE_ERROR');
    }
    if (!query.code) return this.fail('error', mode, 'GOOGLE_ERROR');

    let claims;
    try {
      claims = await this.client.exchangeForClaims(query.code, saved.verifier);
    } catch (error) {
      this.logger.warn(
        `Google sign-in exchange failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return this.fail('error', mode, 'GOOGLE_ERROR');
    }

    const email = normalizeEmail(claims.email);
    const [bySub, byEmail] = await Promise.all([
      this.users.findByGoogleSub(claims.sub),
      this.users.findByEmail(email),
    ]);

    const decision = decideGoogleSignIn({
      claims,
      bySub: toCandidate(bySub),
      byEmail: toCandidate(byEmail),
    });

    if (decision.kind === 'refuse')
      return this.fail('error', mode, decision.code);

    if (decision.kind === 'create') {
      const created = await this.users.createFromGoogle({
        email,
        name: claims.name,
        googleSub: claims.sub,
      });
      await this.loginActivity.recordSync(created.id, ip);
      return this.succeed(mode, created.id, created.email);
    }

    await this.users.applyGoogleSignIn(decision.user.id, {
      googleSub: decision.linkSub ? claims.sub : null,
      name: claims.name,
    });
    await this.loginActivity.record(decision.user.id, ip);
    // The stored email, not Google's spelling: the session's email claim is
    // compared against the allowlist and shown back to the user.
    return this.succeed(mode, decision.user.id, decision.user.email);
  }

  private succeed(
    mode: GoogleAuthMode,
    userId: string,
    email: string,
  ): GoogleCallbackResult {
    return {
      redirectUrl: this.done('success', mode),
      session: { userId, email },
    };
  }

  private fail(
    status: GoogleDoneStatus,
    mode: GoogleAuthMode,
    code?: string,
  ): GoogleCallbackResult {
    return { redirectUrl: this.done(status, mode, code), session: null };
  }

  private done(
    status: GoogleDoneStatus,
    mode: GoogleAuthMode,
    code?: string,
  ): string {
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
    return buildDoneUrl(frontendUrl, { status, code, mode });
  }

  private stateSecret(): string {
    const secret =
      this.config.get<string>('GOOGLE_AUTH_STATE_SECRET') ??
      this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret)
      throw new Error('No secret available to sign Google auth state');
    return secret;
  }
}

function toCandidate(
  user:
    | {
        id: string;
        email: string;
        role: string;
        isActive: boolean;
        googleSub: string | null;
      }
    | undefined,
): GoogleCandidate | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    googleSub: user.googleSub,
  };
}
