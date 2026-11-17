import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MyWorkspacesService, type MyWorkspace } from './my-workspaces.service';
import { UpdatePreferencesDto } from './preferences/dto/update-preferences.dto';
import type { UserPreferences } from './preferences/user-preferences';
import { UserPreferencesService } from './preferences/user-preferences.service';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
}

/**
 * The signed-in person's own account settings. Always the caller's row: the
 * id comes from the JWT, never from the URL.
 *
 * Registered FIRST in UsersModule.controllers: UsersController owns
 * `users/:id`, and a `users/me/...` route declared after it can be shadowed.
 */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class AccountSettingsController {
  constructor(
    private readonly preferences: UserPreferencesService,
    private readonly myWorkspaces: MyWorkspacesService,
  ) {}

  @Get('preferences')
  getPreferences(@CurrentUser() caller: Caller): Promise<UserPreferences> {
    return this.preferences.get(caller.userId);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() caller: Caller,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    return this.preferences.update(caller.userId, dto);
  }

  /** Every workspace the caller owns or has joined (Settings > Profile). */
  @Get('workspaces')
  getWorkspaces(
    @CurrentUser() caller: Caller,
  ): Promise<{ workspaces: MyWorkspace[] }> {
    return this.myWorkspaces.list(caller.userId);
  }
}
