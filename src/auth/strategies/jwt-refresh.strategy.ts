import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import {
  assertNotDeleted,
  assertSessionLive,
  assertSessionTokenShape,
} from './jwt.strategy';

export interface JwtRefreshPayload {
  sub: string;
  email: string;
  iat?: number;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
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
    assertSessionLive(payload.iat, user.sessionsRevokedAt);

    // The current address, not the claim: /auth/refresh re-mints both tokens
    // from this, so a stale claim would otherwise live on after an email change.
    return { userId: payload.sub, email: user.email, refreshToken };
  }
}
