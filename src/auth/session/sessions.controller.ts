import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { DeviceType } from '../../drizzle/schema/user-sessions.schema';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SkipLaunchGate } from '../decorators/skip-launch-gate.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { JwtUser } from '../strategies/jwt.strategy';
import { sessionIsCurrent } from '../two-factor/mfa-errors';
import { SessionStore } from './session-store';

/** One row of Settings -> Security -> Sessions. Never the IP or device hash. */
export interface SessionView {
  id: string;
  label: string;
  deviceType: DeviceType;
  country: string | null;
  lastUsedAt: string;
  isCurrent: boolean;
}

/**
 * The signed-in user's own sessions (spec §7.1): list, end one, end the
 * rest. Every query is scoped by the caller's user id, so another user's
 * session id is a 404, never a revoke.
 */
@Controller('users/me/sessions')
@UseGuards(JwtAuthGuard)
// Securing an account must work before launch access.
@SkipLaunchGate()
export class SessionsController {
  constructor(private readonly sessions: SessionStore) {}

  /** Live sessions: the current one first, then the most recently used. */
  @Get()
  async list(
    @CurrentUser() caller: JwtUser,
  ): Promise<{ sessions: SessionView[] }> {
    const rows = await this.sessions.listLive(caller.userId);
    const views = rows.map(
      (r): SessionView => ({
        id: r.id,
        label: r.label,
        deviceType: r.deviceType,
        country: r.country ?? null,
        lastUsedAt: r.lastUsedAt.toISOString(),
        isCurrent: caller.sid !== null && r.id === caller.sid,
      }),
    );
    views.sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        b.lastUsedAt.localeCompare(a.lastUsedAt),
    );
    return { sessions: views };
  }

  /** Ends one other session. The current one is "Log out", not this. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() caller: JwtUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    if (caller.sid !== null && id === caller.sid) throw sessionIsCurrent();
    if (!(await this.sessions.revoke(caller.userId, id))) {
      throw new NotFoundException('Session not found');
    }
  }

  /**
   * "Log out of all other sessions": every other row, the legacy floor and
   * trusted devices (SessionStore.revokeOthers); the caller's own stays.
   */
  @Post('revoke-others')
  @HttpCode(HttpStatus.OK)
  async revokeOthers(
    @CurrentUser() caller: JwtUser,
  ): Promise<{ revoked: number }> {
    return {
      revoked: await this.sessions.revokeOthers(caller.userId, caller.sid),
    };
  }
}
