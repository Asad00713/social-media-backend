import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { notificationRoutes, socialMediaChannels } from '../drizzle/schema';
import { NotificationRoutesService } from './notification-routes.service';
import { ChannelService } from '../channels/services/channel.service';
import { SlackService } from '../channels/services/slack.service';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';
import type { NotificationRoute } from '../drizzle/schema/notification-routes.schema';

/**
 * Dispatchable event names — a superset of AnalyticsEventName that includes
 * Schedura business events which may not have a WebSocket counterpart (yet).
 *
 * 'lead.created'  — fires when a Meta Lead Ad lead is ingested (in AnalyticsEventName)
 * 'inbox.urgent'  — fires when an inbox item is flagged urgent (custom, not in AnalyticsEventName)
 * 'boost.published', 'boost.failed', 'campaign.activated' — Meta Ads lifecycle events
 */
const DISPATCHABLE_EVENTS = [
  'boost.published',
  'boost.failed',
  'lead.created',
  'campaign.activated',
  'inbox.urgent',
] as const;

type DispatchableEvent = (typeof DISPATCHABLE_EVENTS)[number];

@Injectable()
export class NotificationDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    private readonly routes: NotificationRoutesService,
    private readonly channels: ChannelService,
    private readonly slack: SlackService,
    private readonly events: AnalyticsEventEmitter,
  ) {}

  onModuleInit(): void {
    for (const eventType of DISPATCHABLE_EVENTS) {
      this.events.subscribeRaw(eventType, (payload: unknown) => {
        void this.handle(eventType, payload);
      });
    }
    this.logger.log(
      `Dispatcher listening on: ${DISPATCHABLE_EVENTS.join(', ')}`,
    );
  }

  private async handle(
    eventType: DispatchableEvent,
    payload: unknown,
  ): Promise<void> {
    const p = payload as Record<string, unknown>;
    const workspaceId = p?.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId) return;

    let enabledRoutes: NotificationRoute[];
    try {
      enabledRoutes = await this.routes.forEvent(workspaceId, eventType);
    } catch (err) {
      this.logger.error(
        `Failed to query routes for ${eventType} ws=${workspaceId}: ${(err as Error).message}`,
      );
      return;
    }

    if (enabledRoutes.length === 0) return;

    for (const route of enabledRoutes) {
      try {
        await this.deliver(route, eventType, p);
      } catch (err) {
        this.logger.error(
          `Failed to deliver ${eventType} via route ${route.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async deliver(
    route: NotificationRoute,
    eventType: DispatchableEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, route.channelId))
      .limit(1);

    if (!channel) {
      this.logger.warn(
        `Route ${route.id} references missing channel ${route.channelId} — skipping`,
      );
      return;
    }

    const text = renderMessage(eventType, payload);

    if (channel.platform === 'slack') {
      const token = await this.channels.getAccessToken(
        channel.id,
        channel.workspaceId,
      );
      await this.slack.postMessage(token, {
        channel: route.targetPlatformChannelId,
        text,
      });
      this.logger.debug(
        `Delivered ${eventType} → Slack channel ${route.targetPlatformChannelId} (route ${route.id})`,
      );
      return;
    }

    // Telegram + Discord are wired in their own plans.
    this.logger.warn(
      `No sender wired for platform "${channel.platform}" (route ${route.id}) — skipping`,
    );
  }
}

// ---------------------------------------------------------------------------
// Message renderer
// ---------------------------------------------------------------------------

function renderMessage(
  eventType: DispatchableEvent,
  payload: Record<string, unknown>,
): string {
  const campaignLabel =
    (payload.campaignName as string | undefined) ??
    (payload.campaignId as string | undefined) ??
    'unknown campaign';

  switch (eventType) {
    case 'boost.published':
      return `✅ Boost published: *${campaignLabel}*`;

    case 'boost.failed':
      return [
        `❌ Boost failed: *${campaignLabel}*`,
        payload.error ? String(payload.error) : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'lead.created': {
      const leadId = (payload.leadId as string | undefined) ?? 'unknown';
      const formId = (payload.leadFormId as string | undefined) ?? '';
      return `🎯 New lead captured (id: ${leadId}${formId ? `, form: ${formId}` : ''})`;
    }

    case 'campaign.activated':
      return `▶️ Campaign activated: *${campaignLabel}*`;

    case 'inbox.urgent': {
      const author =
        (payload.authorDisplayName as string | undefined) ?? 'unknown';
      const text = ((payload.text as string | undefined) ?? '').slice(0, 200);
      return `🔥 Urgent inbox item from ${author}: "${text}"`;
    }

    default:
      return `Schedura event: ${eventType as string}`;
  }
}
