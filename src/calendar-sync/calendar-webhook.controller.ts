import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  calendarSyncState,
  CalendarSyncStateRow,
} from '../drizzle/schema/calendar-sync.schema';
import {
  CALENDAR_RECONCILE_JOB,
  CALENDAR_RECONCILE_QUEUE,
  CALENDAR_WEBHOOK_DEBOUNCE_MS,
} from './calendar-sync.constants';
import { verifyCalendarWebhookSecret } from './calendar-webhook.util';

/** Graph change-notification envelope (only the fields we act on). */
interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
}
interface GraphNotificationBatch {
  value?: GraphNotification[];
}

/**
 * CalendarWebhookController — provider change-notification callbacks.
 *
 * PUBLIC by design: Google and Microsoft call these, so there is deliberately no
 * `@UseGuards(JwtAuthGuard)` (the app has no global APP_GUARD — auth is opt-in
 * per controller, exactly like `channels/webhooks.controller.ts`). Authenticity
 * is instead proven by the per-channel secret we handed the provider at
 * subscribe time (`X-Goog-Channel-Token` / Graph `clientState`), verified in
 * constant time against the HMAC of the channel id.
 *
 * Two hard rules:
 *  1. **Never trust the payload.** Neither provider tells us WHAT changed in a
 *     trustworthy way, so a notification only ever enqueues a reconcile job —
 *     the delta pull is the single source of truth.
 *  2. **Never answer 5xx.** Google disables a push channel after repeated
 *     failures and Graph drops a subscription; a validation failure is logged
 *     and answered 2xx so the subscription survives (the 15-min reconcile poll
 *     covers anything we drop).
 */
@Controller('calendar-sync/webhooks')
export class CalendarWebhookController {
  private readonly logger = new Logger(CalendarWebhookController.name);

  constructor(
    @InjectQueue(CALENDAR_RECONCILE_QUEUE) private readonly queue: Queue,
  ) {}

  // ==========================================================================
  // Google Calendar push notifications
  // ==========================================================================

  /**
   * Google sends an EMPTY body plus headers:
   *   X-Goog-Channel-ID      the watch-channel id we generated (→ our state row)
   *   X-Goog-Resource-ID     opaque resource id
   *   X-Goog-Channel-Token   the secret we handed it at watch time
   *   X-Goog-Resource-State  'sync' (handshake, sent once at watch creation) |
   *                          'exists' | 'not_exists'
   */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async handleGoogle(
    @Headers('x-goog-channel-id') watchChannelId: string | undefined,
    @Headers('x-goog-channel-token') channelToken: string | undefined,
    @Headers('x-goog-resource-state') resourceState: string | undefined,
  ): Promise<{ status: string }> {
    // NOTE: the whole body is wrapped so that an internal fault (DB blip, Redis
    // hiccup) can NEVER escape as a 500 — Google disables a push channel after
    // sustained failures, which would silently kill this connection's webhook.
    // The 15-min reconcile poll covers anything we drop here (rule #2 above).
    try {
      // Handshake ping fired the moment the watch is created — nothing changed.
      if (resourceState === 'sync') {
        this.logger.debug(
          `Google calendar webhook: sync handshake for watch channel ${watchChannelId}`,
        );
        return { status: 'ok' };
      }

      if (!watchChannelId) {
        this.logger.warn('Google calendar webhook: missing X-Goog-Channel-ID');
        return { status: 'ignored' };
      }

      const state = await this.findStateByWatchChannelId(watchChannelId);
      if (!state) {
        // Stale watch (channel disconnected, secret rotated). 200 anyway —
        // Google retries + eventually disables 5xx-ing endpoints.
        this.logger.warn(
          `Google calendar webhook: no sync state for watch channel ${watchChannelId}`,
        );
        return { status: 'ignored' };
      }

      if (!verifyCalendarWebhookSecret(state.channelId, channelToken)) {
        this.logger.warn(
          `Google calendar webhook: channel-token mismatch for channel ${state.channelId} — ignoring`,
        );
        return { status: 'ignored' };
      }

      await this.enqueueReconcile(state.channelId, 'google');
      return { status: 'ok' };
    } catch (error) {
      this.logger.error(
        `Google calendar webhook: failed to process a notification for watch channel ${watchChannelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // 2xx on purpose — see the note above.
      return { status: 'ignored' };
    }
  }

  // ==========================================================================
  // Microsoft Graph change notifications
  // ==========================================================================

  /**
   * Two shapes on the same route:
   *  - **Validation handshake:** Graph POSTs `?validationToken=...` when the
   *    subscription is created and expects the RAW token echoed back as
   *    `text/plain` within ~10s. Anything else and the subscription is refused.
   *  - **Change notification:** `{ value: [{ subscriptionId, clientState, ... }] }`
   *    → verify clientState, enqueue a reconcile per subscription, answer 202.
   */
  @Post('outlook')
  async handleOutlook(
    @Query('validationToken') validationToken: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (validationToken) {
      this.logger.log('Outlook calendar webhook: validation handshake');
      res.status(HttpStatus.OK).type('text/plain').send(validationToken);
      return;
    }

    const notifications = (body as GraphNotificationBatch)?.value ?? [];

    for (const notification of notifications) {
      try {
        if (!notification?.subscriptionId) continue;

        const state = await this.findStateBySubscriptionId(
          notification.subscriptionId,
        );
        if (!state) {
          this.logger.warn(
            `Outlook calendar webhook: no sync state for subscription ${notification.subscriptionId}`,
          );
          continue;
        }

        if (
          !verifyCalendarWebhookSecret(
            state.channelId,
            notification.clientState,
          )
        ) {
          this.logger.warn(
            `Outlook calendar webhook: clientState mismatch for channel ${state.channelId} — ignoring`,
          );
          continue;
        }

        await this.enqueueReconcile(state.channelId, 'outlook');
      } catch (error) {
        // One bad notification must never fail the batch (→ 5xx → dropped sub).
        this.logger.warn(
          `Outlook calendar webhook: failed to process a notification: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    res.status(HttpStatus.ACCEPTED).json({ status: 'accepted' });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async findStateByWatchChannelId(
    watchChannelId: string,
  ): Promise<CalendarSyncStateRow | undefined> {
    const [state] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.watchChannelId, watchChannelId));
    return state;
  }

  private async findStateBySubscriptionId(
    subscriptionId: string,
  ): Promise<CalendarSyncStateRow | undefined> {
    const [state] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.subscriptionId, subscriptionId));
    return state;
  }

  /**
   * The webhook only ever says "something changed" — the reconcile job does the
   * authoritative delta pull.
   *
   * COALESCED, because a provider sends one notification PER CHANGED EVENT: the
   * jobId is bucketed into a {@link CALENDAR_WEBHOOK_DEBOUNCE_MS} window (the
   * same trick `CalendarSyncScheduler` uses for the poll) and the job is delayed
   * until the END of that bucket. BullMQ rejects a duplicate jobId while the job
   * is still queued, so a 200-notification burst collapses into exactly ONE
   * delta pull instead of 200.
   */
  private async enqueueReconcile(
    channelId: number,
    provider: string,
  ): Promise<void> {
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / CALENDAR_WEBHOOK_DEBOUNCE_MS);
    // Fire at the bucket boundary → every notification inside the bucket dedupes
    // against the job already sitting in the delayed set.
    const delay = (bucket + 1) * CALENDAR_WEBHOOK_DEBOUNCE_MS - nowMs;

    await this.queue.add(
      CALENDAR_RECONCILE_JOB,
      { channelId },
      { jobId: `calendar-reconcile-${channelId}-hook-${bucket}`, delay },
    );
    this.logger.log(
      `Calendar webhook (${provider}): reconcile enqueued for channel ${channelId} (bucket ${bucket}, +${delay}ms)`,
    );
  }
}
