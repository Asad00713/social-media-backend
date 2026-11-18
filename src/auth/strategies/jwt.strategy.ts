import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import type { UserRole } from '../../drizzle/schema';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Issued-at, whole seconds. Set on every token we sign. */
  iat?: number;
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

export interface JwtUser {
  userId: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
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

    assertSessionLive(payload.iat, user.sessionsRevokedAt);

    // The address from the row, not the claim: the claim is frozen at sign-in
    // and goes stale after an email change.
    return { userId: payload.sub, email: user.email, role: user.role };
  }
}
