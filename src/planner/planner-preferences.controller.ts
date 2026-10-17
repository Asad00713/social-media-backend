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
import { UpdatePlannerPrefsDto } from './dto/planner-prefs.dto';
import type { PlannerPrefs } from './lib/planner-prefs';
import { PlannerPreferencesService } from './services/planner-preferences.service';

/**
 * Personal view settings: every role that can see the Planner (`posts:draft`,
 * so Guests too) reads and writes its own row. The row is chosen by the JWT
 * user, never by anything in the request body.
 */
@Controller('planner/workspaces/:workspaceId/preferences')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerPreferencesController {
  constructor(private readonly preferences: PlannerPreferencesService) {}

  @RequireCapability('posts:draft')
  @Get()
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<PlannerPrefs> {
    return await this.preferences.get(user.userId, workspaceId);
  }

  /** Merges the patch (the View menu writes one key at a time). */
  @RequireCapability('posts:draft')
  @Put()
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdatePlannerPrefsDto,
  ): Promise<PlannerPrefs> {
    return await this.preferences.update(user.userId, workspaceId, dto);
  }
}
