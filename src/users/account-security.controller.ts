import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { setRefreshCookie } from '../auth/refresh-cookie';
import { AccountSecurityService } from './account-security.service';
import { ChangePasswordDto } from './dto/change-password.dto';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
  email: string;
}

/**
 * Throttle key for the signed-in person. The class-level JwtAuthGuard runs
 * before the method's ThrottlerGuard, so `req.user` is always set here.
 */
function perUserTracker(req: Record<string, unknown>): string {
  return 'pw:' + (req.user as Caller).userId;
}

/**
 * The signed-in person's own account security. Registered in AuthModule, not
 * UsersModule: it mints tokens through AuthService, and AuthModule already
 * imports UsersModule, so the other way round would be a module cycle.
 */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class AccountSecurityController {
  constructor(
    private readonly security: AccountSecurityService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Changes the password and signs out every other session. This device gets
   * a fresh pair, minted after the revocation, so it stays signed in.
   * 5 an hour per user, not per IP: a stolen access token can rotate IPs.
   */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { limit: 5, ttl: 3_600_000, getTracker: perUserTracker },
  })
  async changePassword(
    @CurrentUser() caller: Caller,
    @Body() dto: ChangePasswordDto,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string }> {
    await this.security.changePassword(caller.userId, dto, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    const accessToken = await this.auth.generateAccessToken(
      caller.userId,
      caller.email,
    );
    setRefreshCookie(
      response,
      await this.auth.generateRefreshToken(caller.userId, caller.email),
    );
    return { accessToken };
  }
}
