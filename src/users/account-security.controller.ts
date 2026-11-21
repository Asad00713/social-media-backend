import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SessionIssuer } from '../auth/session/session-issuer';
import { AccountSecurityService } from './account-security.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DisconnectGoogleDto } from './dto/disconnect-google.dto';
import {
  ConfirmEmailChangeDto,
  RequestEmailChangeDto,
} from './dto/email-change.dto';
import { EmailChangeService } from './email-change.service';
import type { PublicUser } from './users.service';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
  email: string;
  /** The session the access token belongs to; null for a pre-deploy token. */
  sid?: string | null;
}

/**
 * The signed-in person's id for a throttle key. The class-level JwtAuthGuard
 * runs before the method's ThrottlerGuard, so `req.user` is set in practice;
 * if it ever is not, that is a 401, never a TypeError (500).
 */
function callerIdOf(req: Record<string, unknown>): string {
  const user = req.user as Partial<Caller> | undefined;
  if (!user?.userId) throw new UnauthorizedException();
  return user.userId;
}

/** Throttle key for the password change. */
function perUserTracker(req: Record<string, unknown>): string {
  return 'pw:' + callerIdOf(req);
}

/** The same, for the email change (spec §7.1: 5 an hour per user). */
function emailChangeTracker(req: Record<string, unknown>): string {
  return 'email:' + callerIdOf(req);
}

/** The same, for disconnecting Google (spec §7.1: 5 an hour per user). */
function googleDisconnectTracker(req: Record<string, unknown>): string {
  return 'google:' + callerIdOf(req);
}

/**
 * The signed-in person's own account security. Registered in AuthModule, not
 * UsersModule: it mints tokens through SessionIssuer, and AuthModule already
 * imports UsersModule, so the other way round would be a module cycle.
 */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class AccountSecurityController {
  constructor(
    private readonly security: AccountSecurityService,
    private readonly issuer: SessionIssuer,
    private readonly emailChange: EmailChangeService,
  ) {}

  /**
   * Changes the password and signs out every other session. This device gets
   * a fresh pair for its own session, minted after the revocation, so it
   * stays signed in.
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
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string }> {
    await this.security.changePassword(caller.userId, dto, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    const { accessToken } = await this.issuer.issue(
      caller.userId,
      request,
      response,
      { via: 'password_change', sid: caller.sid ?? null },
    );
    return { accessToken };
  }

  /**
   * Starts an email change: a code goes to the new address (A3). 202, because
   * nothing changes until the code comes back. 5 an hour per user.
   */
  @Post('email-change')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { limit: 5, ttl: 3_600_000, getTracker: emailChangeTracker },
  })
  requestEmailChange(
    @CurrentUser() caller: Caller,
    @Body() dto: RequestEmailChangeDto,
  ): Promise<{ pendingEmail: string; expiresAt: string }> {
    return this.emailChange.request(caller.userId, dto);
  }

  /**
   * Unlinks Google, after the password is re-entered. A wrong password is a
   * 400 `WRONG_PASSWORD`. 5 an hour per user: the password is guessable here
   * by whoever holds a stolen access token.
   */
  @Post('google/disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { limit: 5, ttl: 3_600_000, getTracker: googleDisconnectTracker },
  })
  disconnectGoogle(
    @CurrentUser() caller: Caller,
    @Body() dto: DisconnectGoogleDto,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<PublicUser> {
    return this.security.disconnectGoogle(caller.userId, dto.currentPassword, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  /** Switches the email when the code matches, and tells the old address (A4). */
  @Post('email-change/confirm')
  @HttpCode(HttpStatus.OK)
  confirmEmailChange(
    @CurrentUser() caller: Caller,
    @Body() dto: ConfirmEmailChangeDto,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<PublicUser> {
    return this.emailChange.confirm(caller.userId, dto.code, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
