import {
    Controller,
    Post,
    Body,
    HttpCode,
    HttpStatus,
    Res,
    UseGuards,
    Get,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Post('register')
    @HttpCode(HttpStatus.CREATED)
    async register(
        @Body() createUserDto: CreateUserDto,
        @Res({ passthrough: true }) response: Response
    ) {
        const { accessToken, user } = await this.authService.register(createUserDto);

        const refreshToken = await this.authService.generateRefreshToken(user.id, user.email);

        response.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        return {
            accessToken,
            user
        }
    }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(
        @Body() loginDto: LoginDto,
        @Res({ passthrough: true }) response: Response
    ) {
        const { accessToken, user } = await this.authService.login(loginDto);

        const refreshToken = await this.authService.generateRefreshToken(user.id, user.email);

        response.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        return {
            accessToken,
            user,
        };
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtRefreshGuard)
    async refreshTokens(
        @CurrentUser() user: { userId: string; email: string },
        @Res({ passthrough: true }) response: Response,
    ) {
        const accessToken = await this.authService.refreshTokens(user.userId, user.email);

        const refreshToken = await this.authService.generateRefreshToken(user.userId, user.email);

        response.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        return {
            accessToken,
        };
    }

    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard)
    async logout(@Res({ passthrough: true }) response: Response) {

        response.clearCookie('refreshToken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
        });

        return {
            message: 'Logged out successfully',
        };
    }

    @Get('me')
    @UseGuards(JwtAuthGuard)
    async getProfile(@CurrentUser() user: { userId: string; email: string }) {
        return this.authService.whoAmI(user.userId);
    }
}
