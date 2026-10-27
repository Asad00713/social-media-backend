import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { UpdateInboxSettingsDto } from './dto/inbox-settings.dto';
import {
  InboxSettingsService,
  type InboxSettings,
} from './services/inbox-settings.service';

/** Settings belong to the person, so any member (GUEST included) may use them. */
@Controller('inbox/workspaces/:workspaceId/settings')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class InboxSettingsController {
  constructor(private readonly settings: InboxSettingsService) {}

  @RequireCapability('inbox:view')
  @Get()
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<InboxSettings> {
    return await this.settings.get(user.userId, workspaceId);
  }

  @RequireCapability('inbox:view')
  @Put()
  async put(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateInboxSettingsDto,
  ): Promise<InboxSettings> {
    return await this.settings.update(user.userId, workspaceId, dto);
  }
}
