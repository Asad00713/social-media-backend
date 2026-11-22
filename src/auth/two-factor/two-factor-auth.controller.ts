import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ClientIpThrottlerGuard } from '../../common/guards/client-ip-throttler.guard';
import { requestClientIp } from '../../common/utils/request-client-ip';
import type { RequestContext } from '../../users/account-security.service';
import { UsersService } from '../../users/users.service';
import { TWO_FACTOR_VERIFY_THROTTLE } from '../auth-throttle';
import { SkipLaunchGate } from '../decorators/skip-launch-gate.decorator';
import { SessionIssuer } from '../session/session-issuer';
import { VerifyTwoFactorDto } from './dto/verify-two-factor.dto';
import {
  MAX_CHALLENGE_ATTEMPTS,
  MfaChallengeService,
} from './mfa-challenge.service';
import { mfaChallengeExpired, mfaCodeInvalid, mfaCodeOf } from './mfa-errors';
import { requireOneFactor, SecondFactorService } from './second-factor.service';
import { TwoFactorNotices } from './two-factor-notices.service';

/**
 * The second step of a two-step sign-in (spec §7.2): trade a challenge from
 * `/auth/login` (or the Google callback) plus a TOTP or backup code for a
 * session.
 *
 * Order matters (batch-2 review ruling 1: reserve, then judge):
 *   1. `open` - a bad, expired, burnt or spent challenge is
 *      MFA_CHALLENGE_EXPIRED, before any code is looked at;
 *   2. the body must carry exactly one factor (MFA_CODE_REQUIRED, free);
 *   3. `reserveAttempt` - one of the challenge's five attempts is taken
 *      atomically BEFORE the code is judged, so a burst of parallel
 *      requests on one challenge gets at most five judgements between them;
 *   4. `check` - reserves the account's own attempt the same way (10, then a
 *      15-minute lock). A wrong code keeps the challenge attempt and the
 *      fifth burns the challenge; anything else that stopped the code being
 *      judged (MFA_LOCKED, a failure) gives the challenge attempt back;
 *   5. `consume` - single use; a request that loses the race (or replays a
 *      request that already succeeded) is MFA_CHALLENGE_EXPIRED and mints
 *      nothing;
 *   6. only then the issuer mints, trusting this browser when it is the one
 *      the challenge was made for.
 * A wrong second factor is never a 401 (R5): the client would replay it
 * through /auth/refresh.
 */
@Controller('auth/2fa')
export class TwoFactorAuthController {
  constructor(
    private readonly challenges: MfaChallengeService,
    private readonly secondFactor: SecondFactorService,
    private readonly issuer: SessionIssuer,
    private readonly notices: TwoFactorNotices,
    private readonly users: UsersService,
  ) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(TWO_FACTOR_VERIFY_THROTTLE)
  // Unauthenticated (the gate passes it anyway); a sign-in that started on
  // /auth/login must be able to finish, and login itself stays gated.
  @SkipLaunchGate()
  async verify(
    @Body() dto: VerifyTwoFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const challenge = await this.challenges.open(dto.challengeToken);
    const ctx = contextOf(req);

    const factor = { code: dto.code, backupCode: dto.backupCode };
    requireOneFactor(factor);
    const left = await this.challenges.reserveAttempt(challenge.cid);

    let checked: Awaited<ReturnType<SecondFactorService['check']>>;
    try {
      checked = await this.secondFactor.check(challenge.userId, factor);
    } catch (error) {
      if (mfaCodeOf(error) !== 'MFA_CODE_INVALID') {
        // The code was never judged wrong: the attempt is not spent.
        await this.challenges.release(challenge.cid);
        throw error;
      }
      if (left === MAX_CHALLENGE_ATTEMPTS - 1) {
        // The password was right and the code was not: tell the owner, once
        // per challenge (B7; the notice is keyed by cid and never throws).
        this.detach(this.notices.failed(challenge.userId, ctx, challenge.cid));
      }
      if (left <= 0) {
        await this.challenges.burn(challenge.cid);
        throw mfaChallengeExpired();
      }
      throw mfaCodeInvalid(left);
    }

    if (!(await this.challenges.consume(challenge.cid))) {
      throw mfaChallengeExpired();
    }

    const { accessToken } = await this.issuer.issue(
      challenge.userId,
      req,
      res,
      { via: 'two_factor', trustDeviceHash: challenge.deviceHash },
    );

    if (checked.method === 'backup') {
      this.detach(
        this.notices.backupCodeUsed(
          challenge.userId,
          ctx,
          checked.backupCodesRemaining,
        ),
      );
    }

    return {
      accessToken,
      user: await this.users.findOne(challenge.userId),
    };
  }

  /** A security email never holds up or fails the answer (R9). */
  private detach(notice: Promise<void>): void {
    notice.catch(() => undefined);
  }
}

function contextOf(req: Request): RequestContext {
  const ua = req.headers?.['user-agent'];
  return {
    ip: requestClientIp(req),
    userAgent: typeof ua === 'string' && ua ? ua : null,
  };
}
