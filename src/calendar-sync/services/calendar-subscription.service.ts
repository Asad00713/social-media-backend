import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import {
  calendarSyncState,
  CalendarSyncStateRow,
} from '../../drizzle/schema/calendar-sync.schema';
import { ChannelService } from '../../channels/services/channel.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import {
  GOOGLE_RENEWAL_WINDOW_MS,
  GOOGLE_WATCH_TTL_SECONDS,
  GOOGLE_WEBHOOK_PATH,
  GRAPH_RENEWAL_WINDOW_MS,
  GRAPH_SUBSCRIPTION_TTL_MINUTES,
  OUTLOOK_WEBHOOK_PATH,
} from '../calendar-sync.constants';
import {
  calendarWebhookBaseUrl,
  deriveCalendarWebhookSecret,
} from '../calendar-webhook.util';

const CALENDAR_PLATFORMS = ['google_calendar', 'outlook_calendar'] as const;
type CalendarPlatform = (typeof CALENDAR_PLATFORMS)[number];
type Provider = 'google' | 'outlook';

type CalendarChannel = typeof socialMediaChannels.$inferSelect;

const GOOGLE_API_BASE = 'https://www.googleapis.com/calendar/v3';
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/** Google `events.watch` response (only the fields we persist). */
interface GoogleWatchResponse {
  id?: string;
  resourceId?: string;
  expiration?: string; // epoch millis, as a string
}

/** Graph subscription create/renew response (only the fields we persist). */
interface GraphSubscriptionResponse {
  id?: string;
  expirationDateTime?: string; // ISO-8601
}

/** The row shape `isRenewalDue()` needs — keeps the predicate trivially testable. */
export type RenewalCandidate = Pick<
  CalendarSyncStateRow,
  'provider' | 'watchExpiration' | 'subscriptionExpiration'
>;

/**
 * Pure predicate: is this connection's provider push-subscription close enough
 * to expiry (or already expired) that we must re-arm it?
 *
 *   google  → `watchExpiration` within GOOGLE_RENEWAL_WINDOW_MS (24h)
 *   outlook → `subscriptionExpiration` within GRAPH_RENEWAL_WINDOW_MS (12h)
 *
 * A connection with no subscription at all is NOT "due" — it was never armed
 * (e.g. no public HTTPS callback) and is covered by the reconcile poll instead.
 */
export function isRenewalDue(state: RenewalCandidate, now: Date): boolean {
  if (state.provider === 'google') {
    if (!state.watchExpiration) return false;
    return (
      state.watchExpiration.getTime() - now.getTime() <=
      GOOGLE_RENEWAL_WINDOW_MS
    );
  }
  if (!state.subscriptionExpiration) return false;
  return (
    state.subscriptionExpiration.getTime() - now.getTime() <=
    GRAPH_RENEWAL_WINDOW_MS
  );
}

/**
 * CalendarSubscriptionService — provider push subscriptions (Task E).
 *
 * Arms, renews and tears down the change-notification channel of each connected
 * calendar so external edits reach us within seconds instead of waiting for the
 * 15-minute reconcile poll:
 *
 *   Google  → `POST /calendars/{id}/events/watch` (a "push channel"). It cannot
 *             be renewed, so renewal = `POST /channels/stop` + a fresh watch.
 *   Graph   → `POST /subscriptions` on `/me/events`, renewed in place with
 *             `PATCH /subscriptions/{id}`.
 *
 * Both providers demand a PUBLIC HTTPS callback (Graph even validates it
 * synchronously during creation). When `API_PUBLIC_URL`/`APP_URL` is not an
 * https origin (local dev), subscribing is skipped with a warning — the poll is
 * the safety net and the sync still works, just at poll latency.
 *
 * Nothing here is load-bearing for the connect flow: every method is called
 * fire-and-forget, isolates per-connection failures, and swallows 404s on
 * teardown. The webhook is an optimisation; the poll is the guarantee.
 *
 * Uses the module-level `db` singleton like CalendarPullSyncService (not the
 * DRIZZLE DI token) so both halves of the sync engine stay consistent.
 */
@Injectable()
export class CalendarSubscriptionService {
  private readonly logger = new Logger(CalendarSubscriptionService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly googleCalendarService: GoogleCalendarService,
  ) {}

  // ==========================================================================
  // subscribe
  // ==========================================================================

  /**
   * Arm (or re-arm) the provider push subscription for one calendar channel.
   * Any existing watch/subscription for the channel is torn down first so we
   * never leak provider-side channels.
   *
   * Throws on provider failure — every caller invokes it fire-and-forget with a
   * `.catch()`, since a failed webhook must NEVER break the connect flow.
   */
  async subscribe(channelId: number): Promise<void> {
    const channel = await this.loadCalendarChannel(channelId);
    if (!channel) {
      this.logger.debug(
        `subscribe: channel ${channelId} is not an active connected calendar channel, skipping`,
      );
      return;
    }

    const baseUrl = calendarWebhookBaseUrl();
    if (!baseUrl) {
      this.logger.warn(
        `subscribe: no public HTTPS callback base (API_PUBLIC_URL/APP_URL) — skipping push subscription for channel ${channelId}; the 15-min reconcile poll still keeps this calendar in sync`,
      );
      return;
    }

    const provider = this.providerFor(channel.platform as CalendarPlatform);
    const state = await this.getOrCreateSyncState(channelId, provider);
    const accessToken = await this.channelService.getAccessToken(
      channel.id,
      channel.workspaceId,
    );

    // Never stack two live subscriptions on one connection.
    await this.stopProviderSubscription(state, accessToken);

    if (provider === 'google') {
      await this.subscribeGoogle(channel, state, accessToken, baseUrl);
    } else {
      await this.subscribeOutlook(channel, state, accessToken, baseUrl);
    }
  }

  private async subscribeGoogle(
    channel: CalendarChannel,
    state: CalendarSyncStateRow,
    accessToken: string,
    baseUrl: string,
  ): Promise<void> {
    const calendarId = await this.resolveGoogleCalendarId(channel, accessToken);
    const watchChannelId = randomUUID();

    const response = await fetch(
      `${GOOGLE_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: watchChannelId,
          type: 'web_hook',
          address: `${baseUrl}${GOOGLE_WEBHOOK_PATH}`,
          token: deriveCalendarWebhookSecret(channel.id),
          params: { ttl: String(GOOGLE_WATCH_TTL_SECONDS) },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google events.watch failed for channel ${channel.id} (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const watch = (await response.json()) as GoogleWatchResponse;
    const expiration = watch.expiration
      ? new Date(Number(watch.expiration))
      : null;

    await db
      .update(calendarSyncState)
      .set({
        watchChannelId: watch.id ?? watchChannelId,
        watchResourceId: watch.resourceId ?? null,
        watchExpiration:
          expiration && !Number.isNaN(expiration.getTime()) ? expiration : null,
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.id, state.id));

    this.logger.log(
      `Google calendar watch armed for channel ${channel.id} (expires ${expiration?.toISOString() ?? 'unknown'})`,
    );
  }

  private async subscribeOutlook(
    channel: CalendarChannel,
    state: CalendarSyncStateRow,
    accessToken: string,
    baseUrl: string,
  ): Promise<void> {
    const expirationDateTime = new Date(
      Date.now() + GRAPH_SUBSCRIPTION_TTL_MINUTES * 60 * 1000,
    ).toISOString();

    const response = await fetch(`${GRAPH_API_BASE}/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl: `${baseUrl}${OUTLOOK_WEBHOOK_PATH}`,
        resource: '/me/events',
        expirationDateTime,
        clientState: deriveCalendarWebhookSecret(channel.id),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Graph subscription create failed for channel ${channel.id} (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const subscription = (await response.json()) as GraphSubscriptionResponse;

    await db
      .update(calendarSyncState)
      .set({
        subscriptionId: subscription.id ?? null,
        subscriptionExpiration: parseDate(subscription.expirationDateTime),
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.id, state.id));

    this.logger.log(
      `Outlook calendar subscription armed for channel ${channel.id} (expires ${subscription.expirationDateTime ?? 'unknown'})`,
    );
  }

  // ==========================================================================
  // renewDueSoon
  // ==========================================================================

  /**
   * Re-arm every push subscription inside its provider's safety window. Driven
   * hourly by the renewal queue.
   *
   * Failures are isolated per connection: one dead token must not stop the rest
   * from being renewed. A Graph PATCH that fails falls back to a full re-create.
   */
  async renewDueSoon(): Promise<void> {
    const now = new Date();

    // Cheap pre-filter in SQL (only connections that actually HAVE a
    // subscription), then the authoritative window check with the pure
    // predicate — same rule the unit test pins.
    const candidates = await db
      .select()
      .from(calendarSyncState)
      .where(
        or(
          isNotNull(calendarSyncState.watchExpiration),
          isNotNull(calendarSyncState.subscriptionExpiration),
        ),
      );

    const due = candidates.filter((state) => isRenewalDue(state, now));
    if (due.length === 0) {
      this.logger.verbose('Calendar renewal: nothing due');
      return;
    }

    this.logger.log(
      `Calendar renewal: re-arming ${due.length} subscription(s)`,
    );

    for (const state of due) {
      try {
        await this.renewOne(state);
      } catch (error) {
        this.logger.warn(
          `Calendar renewal failed for channel ${state.channelId} (${state.provider}): ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Graph subscriptions renew in place (PATCH). Google push channels CANNOT be
   * renewed — `subscribe()` stops the old one and creates a fresh watch, which
   * is exactly the renewal path.
   */
  private async renewOne(state: CalendarSyncStateRow): Promise<void> {
    if (state.provider !== 'outlook' || !state.subscriptionId) {
      await this.subscribe(state.channelId);
      return;
    }

    const channel = await this.loadCalendarChannel(state.channelId);
    if (!channel) return;

    const accessToken = await this.channelService.getAccessToken(
      channel.id,
      channel.workspaceId,
    );
    const expirationDateTime = new Date(
      Date.now() + GRAPH_SUBSCRIPTION_TTL_MINUTES * 60 * 1000,
    ).toISOString();

    const response = await fetch(
      `${GRAPH_API_BASE}/subscriptions/${encodeURIComponent(state.subscriptionId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expirationDateTime }),
      },
    );

    if (!response.ok) {
      // Expired / deleted subscription (404 / 400) → re-create from scratch.
      const body = await response.text();
      this.logger.warn(
        `Graph subscription PATCH failed for channel ${state.channelId} (${response.status}): ${body.slice(0, 300)} — re-creating`,
      );
      await this.subscribe(state.channelId);
      return;
    }

    const renewed = (await response.json()) as GraphSubscriptionResponse;

    await db
      .update(calendarSyncState)
      .set({
        subscriptionExpiration:
          parseDate(renewed.expirationDateTime) ??
          parseDate(expirationDateTime),
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.id, state.id));

    this.logger.log(
      `Outlook calendar subscription renewed for channel ${state.channelId} (expires ${renewed.expirationDateTime ?? expirationDateTime})`,
    );
  }

  // ==========================================================================
  // teardown
  // ==========================================================================

  /**
   * Best-effort removal of the provider subscription on disconnect. Called
   * BEFORE the channel row (and its token) is deleted. Never throws — a stale
   * provider-side channel is harmless (it 404s on delivery and expires), while a
   * throw here would break the disconnect flow.
   */
  async teardown(channelId: number): Promise<void> {
    try {
      const [state] = await db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.channelId, channelId));
      if (!state) return;
      if (!state.watchChannelId && !state.subscriptionId) return;

      const channel = await this.loadCalendarChannel(channelId);
      if (channel) {
        const accessToken = await this.channelService.getAccessToken(
          channel.id,
          channel.workspaceId,
        );
        await this.stopProviderSubscription(state, accessToken);
      }

      // Clear the fields even if the provider call failed — the row is about to
      // be cascade-deleted anyway, and a stale id must never be re-used.
      await db
        .update(calendarSyncState)
        .set({
          watchChannelId: null,
          watchResourceId: null,
          watchExpiration: null,
          subscriptionId: null,
          subscriptionExpiration: null,
          updatedAt: new Date(),
        })
        .where(eq(calendarSyncState.id, state.id));

      this.logger.log(
        `Calendar push subscription torn down for channel ${channelId} (${state.provider})`,
      );
    } catch (error) {
      this.logger.warn(
        `Calendar teardown failed for channel ${channelId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Stop whatever subscription the state row currently holds. 404/410 (already
   * gone) is a success. Never throws.
   */
  private async stopProviderSubscription(
    state: CalendarSyncStateRow,
    accessToken: string,
  ): Promise<void> {
    try {
      if (state.provider === 'google') {
        if (!state.watchChannelId || !state.watchResourceId) return;
        const response = await fetch(`${GOOGLE_API_BASE}/channels/stop`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: state.watchChannelId,
            resourceId: state.watchResourceId,
          }),
        });
        if (!response.ok && !isGoneStatus(response.status)) {
          this.logger.warn(
            `Google channels.stop failed for channel ${state.channelId} (${response.status})`,
          );
        }
        return;
      }

      if (!state.subscriptionId) return;
      const response = await fetch(
        `${GRAPH_API_BASE}/subscriptions/${encodeURIComponent(state.subscriptionId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!response.ok && !isGoneStatus(response.status)) {
        this.logger.warn(
          `Graph subscription DELETE failed for channel ${state.channelId} (${response.status})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Stopping the provider subscription for channel ${state.channelId} failed: ${errorMessage(error)}`,
      );
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private providerFor(platform: CalendarPlatform): Provider {
    return platform === 'google_calendar' ? 'google' : 'outlook';
  }

  /**
   * v1 watches the PRIMARY calendar only (one notification stream per
   * connection) — same calendar the delta pull reads. The connect flow already
   * stored its id in `metadata.calendarId`; fall back to a live lookup.
   */
  private async resolveGoogleCalendarId(
    channel: CalendarChannel,
    accessToken: string,
  ): Promise<string> {
    const metadata = (channel.metadata ?? {}) as { calendarId?: string | null };
    if (metadata.calendarId) return metadata.calendarId;

    const primary =
      await this.googleCalendarService.getPrimaryCalendar(accessToken);
    return primary?.id ?? 'primary';
  }

  private async loadCalendarChannel(
    channelId: number,
  ): Promise<CalendarChannel | undefined> {
    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          inArray(socialMediaChannels.platform, [...CALENDAR_PLATFORMS]),
          eq(socialMediaChannels.isActive, true),
          eq(socialMediaChannels.connectionStatus, 'connected'),
        ),
      );
    return channel;
  }

  /** Same get-or-create the pull service uses (unique on channel_id). */
  private async getOrCreateSyncState(
    channelId: number,
    provider: Provider,
  ): Promise<CalendarSyncStateRow> {
    const [existing] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.channelId, channelId));
    if (existing) return existing;

    const [created] = await db
      .insert(calendarSyncState)
      .values({ channelId, provider })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [row] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.channelId, channelId));
    return row;
  }
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Already-gone subscriptions are a successful teardown. */
function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
