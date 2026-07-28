import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';

/**
 * Public (unauthenticated) invitation lookup. Lives in its own controller
 * because WorkspaceMembersController applies JwtAuthGuard at the class level.
 */
@Controller('workspace-members')
export class PublicInvitationsController {
  constructor(private readonly membersService: WorkspaceMembersService) {}

  @Get('invitations/preview')
  preview(@Query('token') token: string) {
    if (!token) throw new BadRequestException('token is required');
    return this.membersService.previewInvitation(token);
  }
}
