import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import type { UserRole } from '../../drizzle/schema';
import { SessionCheck } from '../session/session-check';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Issued-at, whole seconds. Set on every token we sign. */
  iat?: number;
  /** The session row (user_sessions.id); absent on pre-deploy tokens. */
  sid?: string;
}

/**
 * Refuses any token that is not a session token. Several other tokens are
 * signed with JWT_ACCESS_SECRET (or fall back to it): the super-admin
 * challenge token (`purpose: 'admin-login'`, issued after the emailed code and
 * before the password step), the Google state cookie, the TikTok media proxy
 * token. Session tokens carry a string `sub` and never `purpose` or `aud`.
 * Shared by both strategies and both socket handshakes; runs before any lookup.
 */
export function assertSessionTokenShape(payload: unknown): void {
  const claims = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    'purpose' in claims ||
    'aud' in claims
  ) {
    throw new UnauthorizedException('Not a session token');
  }
}

/**
 * Refuses a token issued before the user's sessions were revoked (a password
 * change or reset, "This wasn't me"). `iat` has whole seconds only, so a token
 * from the revocation second itself passes: that is the fresh pair the
 * password change hands back. Shared by the access and refresh strategies and
 * the notifications socket handshake.
 */
export function assertSessionLive(
  iat: number | undefined,
  sessionsRevokedAt: Date | null,
): void {
  if (!sessionsRevokedAt) return;
  if ((iat ?? 0) < Math.floor(sessionsRevokedAt.getTime() / 1000)) {
    throw new UnauthorizedException('Session ended');
  }
}

/**
 * Refuses every token of a soft-deleted account (AccountDeletionService),
 * with a code the frontend can tell apart from an expired session.
 *
 * Needed on top of `sessions_revoked_at`, which the delete also sets: a token
 * minted in the same second as the delete passes assertSessionLive (whole
 * seconds), and this check does not depend on that timing. Shared by both
 * strategies, and checked BEFORE suspension, since a deleted row is also
 * `is_active = false`.
 */
export function assertNotDeleted(deletedAt: Date | null | undefined): void {
  if (!deletedAt) return;
  throw new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'ACCOUNT_DELETED',
    message: 'This account has been deleted.',
  });
}

/**
 * Is this token still a live session? The one check every token consumer
 * runs (both strategies, AllowlistGuard, both socket handshakes; none of them
 * mint). Throws 401 'Session ended' when:
 *   - it is not a session token at all (`purpose` / `aud` claims, no string
 *     `sub`): the admin and MFA challenge tokens open nothing but their own
 *     verify step (Review Focus 1);
 *   - it carries a `sid` whose row is revoked, idle-expired or someone
 *     else's (30 s cache, SessionCheck);
 *   - it carries no `sid` (a pre-deploy token) and predates the user's
 *     `sessions_revoked_at` floor.
 * A token WITH a sid is judged by its row only (B1): the floor moves on
 * "log out of other sessions" to kill legacy tokens, and must not take the
 * caller's own session with it.
 */
export async function assertTokenLive(
  payload: { sub?: unknown; sid?: unknown; iat?: number },
  user: { sessionsRevokedAt: Date | null },
  check: Pick<SessionCheck, 'isLive'>,
): Promise<void> {
  assertSessionTokenShape(payload);
  const sub = payload.sub as string;
  if ('sid' in payload && payload.sid !== undefined) {
    const sid = sidOf(payload);
    if (!sid || !(await check.isLive(sid, sub))) {
      throw new UnauthorizedException('Session ended');
    }
    return;
  }
  assertSessionLive(payload.iat, user.sessionsRevokedAt);
}

/** The token's session id, or null when it carries none (pre-deploy). */
export function sidOf(payload: { sid?: unknown }): string | null {
  return typeof payload.sid === 'string' && payload.sid ? payload.sid : null;
}

export interface JwtUser {
  userId: string;
  email: string;
  role: UserRole;
  /**
   * The session this token belongs to, null for a pre-deploy token. Passed
   * through so a reissue (password change) keeps the caller's session row.
   */
  sid: string | null;
  /** The access token's issued-at (whole seconds). Not the sign-in time. */
  iat: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
    private sessionCheck: SessionCheck,
  ) {
    const secret = configService.get<string>('JWT_ACCESS_SECRET');

    if (!secret) {
      throw new Error(
        'JWT_ACCESS_SECRET is not defined in environment variables',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtUser> {
    assertSessionTokenShape(payload);

    const user = await this.usersService.findOneWithSuspension(payload.sub);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Before the suspension check: a deleted account is also inactive, and
    // must say so as ACCOUNT_DELETED, not ACCOUNT_SUSPENDED.
    assertNotDeleted(user.deletedAt);

    // Check if user is suspended
    if (!user.isActive) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'ACCOUNT_SUSPENDED',
        reason: user.suspendedReason ?? 'manual',
        message: 'Your account has been suspended.',
      });
    }

    await assertTokenLive(payload, user, this.sessionCheck);

    // The address from the row, not the claim: the claim is frozen at sign-in
    // and goes stale after an email change.
    return {
      userId: payload.sub,
      email: user.email,
      role: user.role,
      sid: sidOf(payload),
      iat: payload.iat ?? 0,
    };
  }
}
