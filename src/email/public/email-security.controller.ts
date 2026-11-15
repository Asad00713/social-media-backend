import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import { ReportsPublicThrottlerGuard } from '../../insights/reports/reports-public-throttler.guard';
import {
  confirmPage,
  donePage,
  invalidLinkPage,
  sendPage,
  setPageHeaders,
} from './email-pages';
import { SecurityActionsService } from './security-actions.service';

/** Shown for a bad, expired or tampered security link. */
const SECURITY_LINK_HINT =
  'Security links work for 7 days, and this one may have expired or been copied incompletely. If you think someone else is in your account, choose a new password with "Forgot password" on the sign-in page.';

/**
 * The security links of A4, A5 and A6 (spec §7.3): the same two-step pages as
 * the unsubscribe link, under `/email`. The token in the path is the
 * credential, so a bad one is always the same plain 404 page, never a 401.
 *
 * Registered in AuthModule, not EmailModule: securing an account needs
 * AuthService (the reset link) and AccountSecurityService (UsersModule), and
 * both of those modules already import EmailModule, so EmailModule importing
 * them back would be a module cycle.
 */
@Controller('email')
@SkipLaunchGate()
export class EmailSecurityController {
  constructor(private readonly actions: SecurityActionsService) {}

  /** Step one: asks, changes nothing, so a link scanner's prefetch is harmless. */
  @Get('security/:token')
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirm(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    setPageHeaders(res);
    const ask = await this.actions.describe(token);
    if (!ask) return sendPage(res, 404, invalidLinkPage(SECURITY_LINK_HINT));
    sendPage(
      res,
      200,
      confirmPage({ ...ask, action: `/email/security/${token}` }),
    );
  }

  /** Step two: the button posts here. Limited per token. */
  @Post('security/:token')
  @HttpCode(200)
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
      getTracker: (req) =>
        'email-sec:' + (req.params as { token: string }).token,
    },
  })
  async act(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    setPageHeaders(res);
    const done = await this.actions.perform(token);
    if (!done) return sendPage(res, 404, invalidLinkPage(SECURITY_LINK_HINT));
    sendPage(res, 200, donePage(done));
  }
}
