import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
  Headers,
  Ip,
  Req,
  Res,
  UseGuards,
  Get,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import {
  FORGOT_PASSWORD_THROTTLE,
  LOGIN_THROTTLE,
  REGISTER_THROTTLE,
  RESEND_CODE_THROTTLE,
} from './auth-throttle';
import type { Request, Response } from 'express';
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
import { clearRefreshCookie } from './refresh-cookie';
import { SessionIssuer } from './session/session-issuer';
import { requestClientIp } from '../common/utils/request-client-ip';
import { toPublicUser } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminChallengeService: AdminChallengeService,
    private readonly issuer: SessionIssuer,
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
  // Per-IP ceiling. See auth-throttle.ts for why these four routes and no
  // others: the rest of this controller is bounded by an atomic attempt
  // counter, a 256-bit token, or a JWT.
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(REGISTER_THROTTLE)
  async register(
    @Body() createUserDto: CreateUserDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // The visitor's address (X-Real-IP), as the issuer stores it, not the
    // proxy's (@Ip()): signup last-seen and region come from it.
    const { user, message } = await this.authService.register(
      createUserDto,
      requestClientIp(request) ?? undefined,
    );

    // The issuer writes the session, sets the refresh cookie and records the
    // signup browser as the first known device, silently.
    const issued = await this.issuer.issue(user.id, request, response, {
      via: 'register',
    });
    if (issued.kind === 'mfa') {
      return {
        mfaRequired: true as const,
        challengeToken: issued.challengeToken,
      };
    }

    return {
      accessToken: issued.accessToken,
      user,
      message,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(LOGIN_THROTTLE)
  async login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Every first-factor check; a failure here mints nothing and records no
    // device.
    const user = await this.authService.login(loginDto);

    // A super admin has passed the password AND the emailed code; the issuer
    // stacks TOTP on top when it is on, and never trusts their device (B5).
    const issued = await this.issuer.issue(user.id, request, response, {
      via: user.role === 'SUPER_ADMIN' ? 'admin' : 'password',
    });
    if (issued.kind === 'mfa') {
      return {
        mfaRequired: true as const,
        challengeToken: issued.challengeToken,
      };
    }

    return {
      accessToken: issued.accessToken,
      // Narrowed to the allow-list, so a column added later cannot leak here.
      user: toPublicUser(user),
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  async refreshTokens(
    @CurrentUser() user: { userId: string; sid?: string | null },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Same sid, no rotation: two tabs refreshing at once both succeed. A
    // revoked or idle session is a 401 with no cookie. A pre-deploy token
    // (no sid) gets a session row here.
    const { accessToken } = await this.issuer.issue(
      user.userId,
      request,
      response,
      { via: 'refresh', sid: user.sid ?? null },
    );

    return {
      accessToken,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @SkipLaunchGate()
  async logout(@Res({ passthrough: true }) response: Response) {
    // Same options as the cookie was set with, or the browser keeps it.
    clearRefreshCookie(response);

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
  // Pre-launch setup route: a non-allowlisted user must be able to finish
  // onboarding on their own account even though the launch gate blocks the app.
  @SkipLaunchGate()
  async completeOnboarding(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.authService.markOnboardingCompleted(user.userId);
  }

  // ==================== Email Verification ====================

  // Email verification is pre-launch account setup: the user signing up is not
  // allowlisted yet by definition, and cannot become a verified user without
  // these. Gating them meant a non-allowlisted signup could create an account
  // and then never verify it — a dead end with no way forward or back.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @SkipLaunchGate()
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  // The primary verification path, and the one that actually broke: it carries
  // a JWT (JwtAuthGuard), so unlike the unauthenticated routes here it was
  // blocked on every single request rather than only sometimes.
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @SkipLaunchGate()
  async verifyOtp(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: VerifyOtpDto,
  ) {
    return this.authService.verifyEmailWithOtp(user.userId, dto.otp);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @SkipLaunchGate()
  // Looser than forgot-password on purpose: this is the only button a
  // half-finished signup has, and an hour-long lockout on it has nowhere to
  // go. The 60s per-account cooldown still caps repeats to one address.
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(RESEND_CODE_THROTTLE)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerificationEmail(dto.email);
  }

  // ==================== Password Reset ====================

  // Password reset is account recovery, not product access. Both routes are
  // unauthenticated, so the guard already lets them through for want of a
  // token; the decorator makes that deliberate rather than incidental, and
  // keeps them working if either ever starts carrying one.
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @SkipLaunchGate()
  // Fan-out cap across addresses; AuthService keeps its 5-minute per-account
  // cooldown for repeats to one address.
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(FORGOT_PASSWORD_THROTTLE)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @SkipLaunchGate()
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    // The request context feeds A5's Device and Location rows.
    return this.authService.resetPassword(dto.token, dto.password, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
