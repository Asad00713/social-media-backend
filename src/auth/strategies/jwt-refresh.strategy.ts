import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { SessionCheck } from '../session/session-check';
import {
  assertNotDeleted,
  assertSessionTokenShape,
  assertTokenLive,
  sidOf,
} from './jwt.strategy';

export interface JwtRefreshPayload {
  sub: string;
  email: string;
  iat?: number;
  /** The session row; absent on pre-deploy tokens (refresh then makes one). */
  sid?: string;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
    private sessionCheck: SessionCheck,
  ) {
    const secret = configService.get<string>('JWT_REFRESH_SECRET');

    if (!secret) {
      throw new Error(
        'JWT_REFRESH_SECRET is not defined in environment variables',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => {
          return request?.cookies?.refreshToken;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtRefreshPayload) {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token not found');
    }

    assertSessionTokenShape(payload);

    // findOneWithSuspension for sessionsRevokedAt; suspension itself is still
    // enforced by the access-token strategy only.
    const user = await this.usersService.findOneWithSuspension(payload.sub);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // A deleted account's refresh token never mints a new pair, whatever its
    // iat (the delete also sets sessions_revoked_at; this does not rely on it).
    assertNotDeleted(user.deletedAt);
    // A revoked or idle sid is refused here; the issuer's touch refuses it
    // again (uncached) before minting, so the 30 s cache cannot mint around
    // a revoke made on another instance.
    await assertTokenLive(payload, user, this.sessionCheck);

    // The current address, not the claim: /auth/refresh re-mints both tokens
    // from this, so a stale claim would otherwise live on after an email change.
    return {
      userId: payload.sub,
      email: user.email,
      refreshToken,
      sid: sidOf(payload),
    };
  }
}
