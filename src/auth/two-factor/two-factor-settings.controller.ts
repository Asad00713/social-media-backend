import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SkipLaunchGate } from '../decorators/skip-launch-gate.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { JwtUser } from '../strategies/jwt.strategy';
import { EnableTwoFactorDto } from './dto/enable-two-factor.dto';
import { SecondFactorDto } from './dto/second-factor.dto';
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import { TwoFactorService, type TwoFactorStatus } from './two-factor.service';

/**
 * Throttle key: the signed-in user, not the IP (a stolen access token can
 * rotate IPs). The class-level JwtAuthGuard runs first, so `req.user` is set;
 * if it ever is not, that is a 401, never a TypeError (500).
 */
export function twoFactorTracker(req: Record<string, unknown>): string {
  const user = req.user as Partial<JwtUser> | undefined;
  if (!user?.userId) throw new UnauthorizedException();
  return '2fa:' + user.userId;
}

/** Ten an hour per user for every route that checks a password or a code. */
export const TWO_FACTOR_SETTINGS_THROTTLE = {
  default: { limit: 10, ttl: 3_600_000, getTracker: twoFactorTracker },
};

/** Settings -> Security -> Two-step sign-in (spec §7.2). */
@Controller('users/me/2fa')
@UseGuards(JwtAuthGuard)
// Securing an account must work before launch access.
@SkipLaunchGate()
export class TwoFactorSettingsController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Get()
  status(@CurrentUser() caller: JwtUser): Promise<TwoFactorStatus> {
    return this.twoFactor.status(caller.userId);
  }

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(TWO_FACTOR_SETTINGS_THROTTLE)
  setup(@CurrentUser() caller: JwtUser, @Body() dto: SetupTwoFactorDto) {
    return this.twoFactor.setup(caller, dto);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(TWO_FACTOR_SETTINGS_THROTTLE)
  enable(
    @CurrentUser() caller: JwtUser,
    @Body() dto: EnableTwoFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ backupCodes: string[]; accessToken: string }> {
    return this.twoFactor.enable(caller, dto.code, req, res);
  }

  @Post('backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(TWO_FACTOR_SETTINGS_THROTTLE)
  regenerate(
    @CurrentUser() caller: JwtUser,
    @Body() dto: SecondFactorDto,
    @Req() req: Request,
  ): Promise<{ backupCodes: string[] }> {
    return this.twoFactor.regenerate(
      caller,
      { code: dto.code, backupCode: dto.backupCode },
      req,
    );
  }

  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle(TWO_FACTOR_SETTINGS_THROTTLE)
  disable(
    @CurrentUser() caller: JwtUser,
    @Body() dto: SecondFactorDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.twoFactor.disable(caller, dto, req);
  }
}
