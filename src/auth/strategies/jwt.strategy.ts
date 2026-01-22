import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import type { UserRole } from '../../drizzle/schema';

export interface JwtPayload {
    sub: string;
    email: string;
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
            throw new Error('JWT_ACCESS_SECRET is not defined in environment variables');
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

        // Check if user is suspended
        if (!user.isActive) {
            throw new UnauthorizedException(
                `Your account has been suspended. Reason: ${user.suspendedReason || 'Contact support for details.'}`,
            );
        }

        return { userId: payload.sub, email: payload.email, role: user.role };
    }
}