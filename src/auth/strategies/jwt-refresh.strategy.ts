import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';

export interface JwtRefreshPayload {
    sub: string;
    email: string;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
    constructor(
        private configService: ConfigService,
        private usersService: UsersService,
    ) {
        const secret = configService.get<string>('JWT_REFRESH_SECRET');

        if (!secret) {
            throw new Error('JWT_REFRESH_SECRET is not defined in environment variables');
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

        const user = await this.usersService.findOne(payload.sub);

        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        return { userId: payload.sub, email: payload.email, refreshToken };
    }
}