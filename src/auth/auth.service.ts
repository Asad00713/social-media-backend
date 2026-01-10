import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import type { User } from '../drizzle/schema';
import { CreateUserDto } from '../users/dto/create-user.dto';

export interface TokenPayload {
    sub: string;
    email: string;
}

export interface AuthResponse {
    accessToken: string;
    user: Omit<User, 'password'>;
}

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private configService: ConfigService,
    ) { }

    async register(registerDto: CreateUserDto): Promise<AuthResponse> {
        const user = await this.usersService.create(registerDto);

        const accessToken = await this.generateAccessToken(user.id, user.email);

        return {
            accessToken,
            user,
        };
    }

    async login(loginDto: LoginDto): Promise<AuthResponse> {
        const user = await this.validateUser(loginDto.email, loginDto.password);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const accessToken = await this.generateAccessToken(user.id, user.email);

        const { password, ...userWithoutPassword } = user;

        return {
            accessToken,
            user: userWithoutPassword,
        };
    }

    async validateUser(email: string, password: string): Promise<User | null> {
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            return null;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return null;
        }

        return user;
    }

    async generateAccessToken(userId: string, email: string): Promise<string> {
        const payload = { sub: userId, email };
        const secret = this.configService.get<string>('JWT_ACCESS_SECRET');

        if (!secret) {
            throw new Error('JWT_ACCESS_SECRET is not defined');
        }

        return this.jwtService.sign(payload, {
            secret,
            expiresIn: '15m',
        });
    }

    async generateRefreshToken(userId: string, email: string): Promise<string> {
        const payload = { sub: userId, email };
        const secret = this.configService.get<string>('JWT_REFRESH_SECRET');

        if (!secret) {
            throw new Error('JWT_REFRESH_SECRET is not defined');
        }

        return this.jwtService.sign(payload, {
            secret,
            expiresIn: '7d',
        });
    }

    async refreshTokens(userId: string, email: string): Promise<string> {
        const accessToken = await this.generateAccessToken(userId, email);
        return accessToken;
    }

    async whoAmI(userId: string) {
        const user = await this.usersService.findOne(userId);

        if (!user) {
            throw new UnauthorizedException('User not found')
        }

        return {
            user
        }
    }
}