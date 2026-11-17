// src/workspace-members/join-link.controller.ts
import {
  ArgumentMetadata,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  PipeTransform,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { SkipLaunchGate } from '../auth/decorators/skip-launch-gate.decorator';
import { ClientIpThrottlerGuard } from '../channels/connect-links/client-ip-throttler.guard';
import { INVITE_CODE_REGEX, InviteLinkService } from './invite-link.service';

/** 30 lookups per visitor per 15 minutes: a person never needs more. */
const JOIN_THROTTLE = { default: { limit: 30, ttl: 15 * 60 * 1000 } };

/** A code that cannot be one is a 400, before any database read. */
@Injectable()
export class ParseInviteCodePipe implements PipeTransform<string, string> {
  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !INVITE_CODE_REGEX.test(value)) {
      throw new BadRequestException('Invalid invite code');
    }
    return value;
  }
}

/**
 * Join by invite link. Its own controller because WorkspaceMembersController
 * applies JwtAuthGuard at the class level and the preview is public.
 * Both routes are throttled per visitor (ClientIpThrottlerGuard reads the
 * real client address behind the proxy), which bounds code guessing; a code
 * is 50 bits, so guessing is hopeless long before the limit matters.
 */
@Controller('invitations')
export class JoinLinkController {
  constructor(private readonly inviteLinks: InviteLinkService) {}

  // What the join page shows before sign-in. No auth.
  @Get('join/:code')
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle(JOIN_THROTTLE)
  preview(@Param('code', ParseInviteCodePipe) code: string) {
    return this.inviteLinks.preview(code);
  }

  // Gate-exempt like invitations/accept: a non-allowlisted person who was
  // sent a link must still be able to join the workspace behind it.
  @Post('join/:code')
  @HttpCode(HttpStatus.OK)
  @SkipLaunchGate()
  @UseGuards(JwtAuthGuard, ClientIpThrottlerGuard)
  @Throttle(JOIN_THROTTLE)
  join(
    @Param('code', ParseInviteCodePipe) code: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.inviteLinks.join(code, user.userId);
  }
}
