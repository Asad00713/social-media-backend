import {
  Controller,
  Post,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CalendarPushSyncService } from './services/calendar-push-sync.service';

@Controller('calendar-sync')
@UseGuards(JwtAuthGuard)
export class CalendarSyncController {
  private readonly logger = new Logger(CalendarSyncController.name);

  constructor(private readonly pushSyncService: CalendarPushSyncService) {}

  /**
   * Backfill: push every currently-scheduled future post of a workspace to its
   * connected calendars. Called by the frontend right after a calendar is
   * connected so pre-existing scheduled posts show up. Workspace-scoped: only
   * the workspace's own posts/channels are touched.
   *
   * Auth: the caller must own/belong to `:workspaceId` (this side-effects the
   * workspace's provider calendars) — otherwise 403. The backfill itself runs
   * DETACHED so the request returns 202 immediately instead of hanging on a
   * potentially long per-post provider loop.
   */
  @Post('workspaces/:workspaceId/backfill')
  @HttpCode(HttpStatus.ACCEPTED)
  async backfill(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
  ): Promise<{ status: string }> {
    // IDOR guard — verify membership BEFORE touching any provider calendar.
    await this.pushSyncService.assertWorkspaceAccess(workspaceId, user.userId);

    // Fire-and-forget: don't block the response on the backfill loop. Per-post
    // errors are already logged inside the service; this catch only guards
    // against an unhandled promise rejection.
    void this.pushSyncService.backfillWorkspace(workspaceId).catch((error) => {
      this.logger.warn(
        `Backfill failed for workspace ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return { status: 'accepted' };
  }
}
