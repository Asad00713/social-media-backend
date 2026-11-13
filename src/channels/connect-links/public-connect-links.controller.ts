import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import { ConnectLinkAccessService } from './connect-link-access.service';
import { ForwardedForThrottlerGuard } from './forwarded-for-throttler.guard';

/**
 * What a client's browser calls from /c/:token. No JwtAuthGuard: the token IS
 * the credential, and it only ever reaches what its link offers. Throttled
 * because this is the one place a token is tested; per visitor (first
 * X-Forwarded-For hop), since the app sits behind a proxy.
 */
@Controller('public/connect-links')
@SkipLaunchGate()
@UseGuards(ForwardedForThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicConnectLinksController {
  constructor(private readonly access: ConnectLinkAccessService) {}

  @Get(':token')
  preview(@Param('token') token: string) {
    return this.access.preview(token);
  }

  @Post(':token/:platform/start')
  @HttpCode(HttpStatus.OK)
  start(@Param('token') token: string, @Param('platform') platform: string) {
    return this.access.start(token, platform);
  }
}
