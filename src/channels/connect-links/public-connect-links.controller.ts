import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import { ConnectLinkAccessService } from './connect-link-access.service';
import { ConnectLinkConnectService } from './connect-link-connect.service';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import { ConnectLinkFacebookConnectBody } from './dto/connect-link.dto';

/**
 * What a client's browser calls from /c/:token. No JwtAuthGuard: the token IS
 * the credential, and it only ever reaches what its link offers. Throttled
 * because this is the one place a token is tested; per visitor (first
 * client IP from the proxy headers), since the app sits behind a proxy.
 */
@Controller('public/connect-links')
@SkipLaunchGate()
@UseGuards(ClientIpThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicConnectLinksController {
  constructor(
    private readonly access: ConnectLinkAccessService,
    private readonly connect: ConnectLinkConnectService,
  ) {}

  @Get(':token')
  preview(@Param('token') token: string) {
    return this.access.preview(token);
  }

  @Post(':token/:platform/start')
  @HttpCode(HttpStatus.OK)
  start(@Param('token') token: string, @Param('platform') platform: string) {
    return this.access.start(token, platform);
  }

  /** The Pages of the Facebook sign-in parked by the callback (not used up). */
  @Get(':token/facebook/pages')
  facebookPages(
    @Param('token') token: string,
    @Query('selection') selection: string,
  ) {
    return this.connect.facebookPages(token, selection ?? '');
  }

  /** Connect the chosen Pages; the selection works once. */
  @Post(':token/facebook/connect')
  @HttpCode(HttpStatus.CREATED)
  connectFacebook(
    @Param('token') token: string,
    @Body() body: ConnectLinkFacebookConnectBody,
  ) {
    return this.connect.connectFacebook(token, body);
  }
}
