import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SkipLaunchGate } from '../auth/decorators/skip-launch-gate.decorator';
import { clearRefreshCookie } from '../auth/refresh-cookie';
import { AccountDeletionService } from './account-deletion.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { MyWorkspacesService, type MyWorkspace } from './my-workspaces.service';
import { UpdatePreferencesDto } from './preferences/dto/update-preferences.dto';
import type { UserPreferences } from './preferences/user-preferences';
import { UserPreferencesService } from './preferences/user-preferences.service';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
}

/**
 * Throttle key for the account delete: 3 an hour per user (spec §5.10). The
 * class-level JwtAuthGuard runs before the method's ThrottlerGuard, so
 * `req.user` is set; if it ever is not, that is a 401, never a 500.
 */
export function deleteAccountTracker(req: Record<string, unknown>): string {
  const user = req.user as Partial<Caller> | undefined;
  if (!user?.userId) throw new UnauthorizedException();
  return 'delete:' + user.userId;
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
    private readonly accountDeletion: AccountDeletionService,
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

  /**
   * Every workspace the caller owns or has joined (Settings > Profile).
   * Exempt from the launch gate: it feeds the account-delete dialog's blocker
   * list, which a not-yet-allowlisted sign-up must be able to reach.
   */
  @Get('workspaces')
  @SkipLaunchGate()
  getWorkspaces(
    @CurrentUser() caller: Caller,
  ): Promise<{ workspaces: MyWorkspace[] }> {
    return this.myWorkspaces.list(caller.userId);
  }

  /**
   * Deletes the caller's account (soft delete + anonymise; see
   * AccountDeletionService). 204, and the refresh cookie is cleared in the
   * same response: the frontend cannot call /auth/logout afterwards, since
   * the access token is already refused with ACCOUNT_DELETED.
   *
   * 400 EMAIL_MISMATCH, 409 OWNS_WORKSPACES {workspaces: [{id, name}]},
   * 502 BILLING_CANCEL_FAILED. With two-step sign-in on: 400
   * MFA_CODE_REQUIRED / MFA_CODE_INVALID, 429 MFA_LOCKED.
   *
   * Exempt from the launch gate: a waitlisted sign-up holds a valid token and
   * must be able to erase their own account. It still needs the JWT, and it
   * can only act on the caller's own row.
   */
  @Delete()
  @SkipLaunchGate()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { limit: 3, ttl: 3_600_000, getTracker: deleteAccountTracker },
  })
  async deleteAccount(
    @CurrentUser() caller: Caller,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.accountDeletion.deleteAccount(caller.userId, {
      confirmEmail: dto.confirmEmail,
      code: dto.code,
      backupCode: dto.backupCode,
      actor: 'self',
      actorId: caller.userId,
    });
    clearRefreshCookie(response);
  }
}
