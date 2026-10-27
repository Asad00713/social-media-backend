import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { InboxService } from './inbox.service';

/** Destructive inbox maintenance, platform staff only. */
@Controller('admin/inbox')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class InboxAdminController {
  constructor(private readonly inboxService: InboxService) {}

  @Post('workspaces/:workspaceId/cleanup-orphaned-thread-keys')
  @HttpCode(HttpStatus.OK)
  async cleanupOrphanedThreadKeys(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ) {
    return this.inboxService.cleanupOrphanedThreadKeysForWorkspace(workspaceId);
  }
}
