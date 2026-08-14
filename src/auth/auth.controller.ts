import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Res,
  UseGuards,
  Get,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import {
  AdminChallengeService,
  ChallengeCooldownError,
} from './admin-challenge.service';
import {
  RequestAdminChallengeDto,
  VerifyAdminChallengeDto,
} from './dto/admin-challenge.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { SkipLaunchGate } from './decorators/skip-launch-gate.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminChallengeService: AdminChallengeService,
  ) {}

  // ==================== Admin sign-in second factor ====================

  /**
   * Step one of super admin sign-in: email a one-time code.
   *
   * Public by design — it runs before anyone is authenticated. It answers
   * identically for every address, so it cannot be used to find out which
   * account owns the platform.
   *
   * Throttled hard. Without a ceiling this endpoint is a free way to send mail
   * to an address of the caller's choosing, over and over.
   */
  @Post('admin/challenge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  // Fifteen in fifteen minutes. The old limit of five was set against an
  // imagined attacker rather than a real sign-in: a wrong password sends the
  // form back to this step, so a couple of fumbled attempts plus the codes
  // they each needed burned through five and left the owner locked out by a
  // 429 the UI could only describe as "could not reach the server". The
  // per-address cooldown below is what actually caps outbound mail; this is a
  // backstop against a flood, and fifteen is still far below one.
  @Throttle({ default: { limit: 15, ttl: 15 * 60 * 1000 } })
  async requestAdminChallenge(
    @Body() dto: RequestAdminChallengeDto,
    @Ip() ip: string,
  ) {
    try {
      await this.adminChallengeService.requestChallenge(dto.email, ip);
    } catch (error) {
      if (error instanceof ChallengeCooldownError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `A code was just sent. Check your inbox, or try again in ${error.retryAfterSeconds}s.`,
            retryAfterSeconds: error.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw error;
    }

    // Always the same sentence, always a 200.
    return {
      message: 'If that address can sign in here, a code is on its way.',
    };
  }

  /** Step two: trade a correct code for a short-lived token. */
  @Post('admin/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  async verifyAdminChallenge(@Body() dto: VerifyAdminChallengeDto) {
    const challengeToken = await this.adminChallengeService.verifyChallenge(
      dto.email,
      dto.otp,
    );

    return { challengeToken };
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() createUserDto: CreateUserDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, user, message } =
      await this.authService.register(createUserDto);

    const refreshToken = await this.authService.generateRefreshToken(
      user.id,
      user.email,
    );

    response.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true, // Always true for cross-origin cookies
      sameSite: 'none', // Required for cross-origin cookies
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      accessToken,
      user,
      message,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, user } = await this.authService.login(loginDto, ip);

    const refreshToken = await this.authService.generateRefreshToken(
      user.id,
      user.email,
    );

    response.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true, // Always true for cross-origin cookies
      sameSite: 'none', // Required for cross-origin cookies
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
    @Ip() ip: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const accessToken = await this.authService.refreshTokens(
      user.userId,
      user.email,
      ip,
    );

    const refreshToken = await this.authService.generateRefreshToken(
      user.userId,
      user.email,
    );

    response.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true, // Always true for cross-origin cookies
      sameSite: 'none', // Required for cross-origin cookies
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      accessToken,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @SkipLaunchGate()
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie('refreshToken', {
      httpOnly: true,
      secure: true, // Must match cookie settings
      sameSite: 'none', // Must match cookie settings
    });

    return {
      message: 'Logged out successfully',
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @SkipLaunchGate()
  async getProfile(@CurrentUser() user: { userId: string; email: string }) {
    return this.authService.whoAmI(user.userId);
  }

  @Post('onboarding/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async completeOnboarding(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.authService.markOnboardingCompleted(user.userId);
  }

  // ==================== Email Verification ====================

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async verifyOtp(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: VerifyOtpDto,
  ) {
    return this.authService.verifyEmailWithOtp(user.userId, dto.otp);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerificationEmail(dto.email);
  }

  // ==================== Password Reset ====================

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }
}
