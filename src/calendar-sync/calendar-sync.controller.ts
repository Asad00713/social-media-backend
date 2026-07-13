import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CalendarPushSyncService } from './services/calendar-push-sync.service';
import {
  ExternalEventDto,
  ExternalEventsService,
} from './services/external-events.service';
import { ListExternalEventsDto } from './dto/list-external-events.dto';

@Controller('calendar-sync')
@UseGuards(JwtAuthGuard)
export class CalendarSyncController {
  private readonly logger = new Logger(CalendarSyncController.name);

  constructor(
    private readonly pushSyncService: CalendarPushSyncService,
    private readonly externalEventsService: ExternalEventsService,
  ) {}

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

  /**
   * The workspace's IMPORTED external calendar events (the user's OTHER events,
   * i.e. the ones Schedura did not write) overlapping `[from, to]`. Read-only
   * mirror maintained by CalendarPullSyncService — this endpoint never touches a
   * provider.
   *
   * Auth: same membership check as the backfill endpoint — workspace owner or an
   * ACCEPTED member; otherwise 403.
   */
  @Get('workspaces/:workspaceId/external-events')
  async listExternalEvents(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListExternalEventsDto,
    @CurrentUser() user: { userId: string; email: string },
  ): Promise<ExternalEventDto[]> {
    // IDOR guard — a workspace's calendar events are private to its members.
    await this.pushSyncService.assertWorkspaceAccess(workspaceId, user.userId);

    return this.externalEventsService.listExternalEvents(
      workspaceId,
      query.from,
      query.to,
    );
  }
}
