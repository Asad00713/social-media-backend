import {
  Controller,
  Get,
  Headers,
  Ip,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { SkipLaunchGate } from '../decorators/skip-launch-gate.decorator';
import {
  deviceCookieOf,
  readOrMintDeviceId,
  setDeviceCookie,
} from '../devices/device-cookie';
import { KnownDevicesService } from '../devices/known-devices.service';
import { setRefreshCookie } from '../refresh-cookie';
import { GOOGLE_STATE_COOKIE, GoogleAuthService } from './google-auth.service';
import type { GoogleAuthMode } from './google-sign-in.decision';

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // Lax, not None: the callback is a top-level GET navigation from Google,
  // which Lax cookies ride along on, and nothing else needs to read it.
  sameSite: 'lax' as const,
  path: '/auth/google',
};

/**
 * Unauthenticated by nature — this IS how a session begins. Gate-exempt for
 * the same reason login's own setup routes are: the launch gate only ever
 * looks at an existing bearer token, and these never carry one.
 */
@Controller('auth/google')
@SkipLaunchGate()
export class GoogleAuthController {
  constructor(
    private readonly google: GoogleAuthService,
    private readonly auth: AuthService,
    private readonly knownDevices: KnownDevicesService,
  ) {}

  @Get('start')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 15 * 60 * 1000 } })
  start(@Query('mode') mode: string | undefined, @Res() res: Response) {
    const resolved: GoogleAuthMode = mode === 'redirect' ? 'redirect' : 'popup';
    const { redirectUrl, stateCookie } = this.google.start(resolved);
    if (stateCookie) {
      res.cookie(GOOGLE_STATE_COOKIE, stateCookie, {
        ...STATE_COOKIE_OPTIONS,
        maxAge: 10 * 60 * 1000,
      });
    }
    return res.redirect(302, redirectUrl);
  }

  @Get('callback')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 15 * 60 * 1000 } })
  async callback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Ip() ip: string,
    @Res() res: Response,
    @Headers('user-agent') userAgent?: string,
  ) {
    const stateCookie = (req.cookies as Record<string, string> | undefined)?.[
      GOOGLE_STATE_COOKIE
    ];
    // Single use: cleared before anything else so a replayed callback has no
    // state to match.
    res.clearCookie(GOOGLE_STATE_COOKIE, STATE_COOKIE_OPTIONS);

    const { redirectUrl, session, mode } = await this.google.callback(
      query,
      stateCookie,
      ip,
    );
    if (session) {
      try {
        setRefreshCookie(
          res,
          await this.auth.generateRefreshToken(session.userId, session.email),
        );
      } catch {
        return res.redirect(302, this.google.failureUrl(mode));
      }
      // Only once the session exists. A new account's first browser is
      // recorded without an email; a known account's new one sends A6.
      const device = readOrMintDeviceId(deviceCookieOf(req.cookies));
      setDeviceCookie(res, device.id);
      this.knownDevices.track(
        session.userId,
        device.id,
        { ip, userAgent: userAgent ?? null },
        { silent: session.isNewAccount },
      );
    }
    return res.redirect(302, redirectUrl);
  }
}
