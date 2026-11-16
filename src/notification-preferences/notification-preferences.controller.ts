import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import type { NotificationPreferencesResponse } from './notification-events';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * The caller's own notification switches in one workspace. Every role, GUEST
 * included, holds `team:view`; there is no way to read or write another
 * member's preferences.
 */
@Controller('workspaces/:workspaceId/notification-preferences')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @RequireCapability('team:view')
  list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<NotificationPreferencesResponse> {
    return this.preferences.list(user.userId, workspaceId);
  }

  @Put()
  @RequireCapability('team:view')
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponse> {
    return this.preferences.update(user.userId, workspaceId, dto.changes);
  }
}
