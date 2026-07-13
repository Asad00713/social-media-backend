import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema/posts.schema';
import { scheduledInboxMessages } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../drizzle/schema/workspace-invitation.schema';
import {
  calendarItemLinks,
  CalendarItemLink,
  NewCalendarItemLink,
} from '../../drizzle/schema/calendar-sync.schema';
import { ChannelService } from '../../channels/services/channel.service';
import {
  GoogleCalendarService,
  CalendarEvent,
  CreateEventOptions,
  Calendar,
} from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import {
  EventInput,
  contentHash,
  messageToEventInput,
  postToEventInput,
} from '../calendar-sync.mapper';

// Calendar channel platforms that participate in app→calendar push.
const CALENDAR_PLATFORMS = ['google_calendar', 'outlook_calendar'] as const;
type CalendarPlatform = (typeof CALENDAR_PLATFORMS)[number];

// Minimal provider-service surface the push service depends on. Both
// GoogleCalendarService and OutlookCalendarService satisfy this shape.
interface CalendarProviderService {
  getPrimaryCalendar(accessToken: string): Promise<Calendar | null>;
  createEvent(
    accessToken: string,
    options: CreateEventOptions,
  ): Promise<CalendarEvent>;
  updateEvent(
    accessToken: string,
    eventId: string,
    updates: Partial<CreateEventOptions>,
    calendarId?: string,
  ): Promise<CalendarEvent>;
  deleteEvent(
    accessToken: string,
    eventId: string,
    calendarId?: string,
  ): Promise<void>;
}

type CalendarChannel = typeof socialMediaChannels.$inferSelect;

/**
 * Which app-side item a link/event belongs to. EXACTLY one arc is set, mirroring
 * the `cil_exactly_one_owner` CHECK on `calendar_item_links`.
 */
type ItemRef =
  | { kind: 'post'; postId: string }
  | { kind: 'message'; messageId: string };

/**
 * CalendarPushSyncService — app→calendar push.
 *
 * When a scheduled ITEM (a post, or a scheduled inbox message) is
 * created/updated/unscheduled/cancelled/deleted, upserts or removes the matching
 * event on every connected calendar of the item's workspace, tagging our events
 * with ownership private props (`schedura_post_id` / `schedura_message_id`) and
 * maintaining `calendar_item_links` (etag + lastPushedHash for later two-way echo
 * suppression).
 *
 * Reuses the existing provider services + ChannelService token accessor; never
 * re-authenticates.
 */
@Injectable()
export class CalendarPushSyncService {
  private readonly logger = new Logger(CalendarPushSyncService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly outlookCalendarService: OutlookCalendarService,
  ) {}

  private providerFor(platform: CalendarPlatform): {
    service: CalendarProviderService;
    provider: 'google' | 'outlook';
  } {
    return platform === 'google_calendar'
      ? { service: this.googleCalendarService, provider: 'google' }
      : { service: this.outlookCalendarService, provider: 'outlook' };
  }

  // ==========================================================================
  // Posts
  // ==========================================================================

  /**
   * Upsert (or remove) the calendar event(s) for a single post across every
   * connected calendar of its workspace. Idempotent; per-channel failures are
   * isolated and recorded on the link, never thrown past the loop.
   */
  async syncPost(
    postId: string,
    primaryCalendarCache?: Map<number, string>,
  ): Promise<void> {
    const [post] = await db.select().from(posts).where(eq(posts.id, postId));
    if (!post) {
      this.logger.debug(`syncPost: post ${postId} not found, skipping`);
      return;
    }

    // Only future, still-scheduled posts produce events. Anything else
    // (draft/published/failed/past) → ensure no stale event lingers.
    const isSchedulable =
      post.status === 'scheduled' &&
      !!post.scheduledAt &&
      new Date(post.scheduledAt).getTime() > Date.now();

    if (!isSchedulable) {
      await this.removePostEvent(postId);
      return;
    }

    const eventInput = postToEventInput({
      id: post.id,
      workspaceId: post.workspaceId,
      content: post.content,
      scheduledAt: post.scheduledAt,
    });

    await this.syncItem(
      { kind: 'post', postId: post.id },
      post.workspaceId,
      eventInput,
      primaryCalendarCache,
    );
  }

  // ==========================================================================
  // Scheduled inbox messages (comment replies + DMs)
  // ==========================================================================

  /**
   * Upsert (or remove) the calendar event(s) for a single scheduled inbox
   * message. Only `pending` future messages have events — `sending`, `sent`,
   * `failed` and `cancelled` all resolve to "remove the event".
   */
  async syncMessage(
    messageId: string,
    primaryCalendarCache?: Map<number, string>,
  ): Promise<void> {
    const [message] = await db
      .select()
      .from(scheduledInboxMessages)
      .where(eq(scheduledInboxMessages.id, messageId));
    if (!message) {
      this.logger.debug(
        `syncMessage: scheduled message ${messageId} not found, skipping`,
      );
      return;
    }

    const isSchedulable =
      message.status === 'pending' &&
      !!message.scheduledAt &&
      new Date(message.scheduledAt).getTime() > Date.now();

    if (!isSchedulable) {
      await this.removeMessageEvent(messageId);
      return;
    }

    const eventInput = messageToEventInput({
      id: message.id,
      workspaceId: message.workspaceId,
      text: message.text,
      targetLabel: message.targetLabel,
      scheduledAt: message.scheduledAt,
    });

    await this.syncItem(
      { kind: 'message', messageId: message.id },
      message.workspaceId,
      eventInput,
      primaryCalendarCache,
    );
  }

  // ==========================================================================
  // Shared push core
  // ==========================================================================

  /**
   * Fan one item's event body out to every connected calendar of its workspace.
   * Per-channel failures are isolated so one bad connection can't abort the rest.
   */
  private async syncItem(
    item: ItemRef,
    workspaceId: string,
    eventInput: EventInput,
    primaryCalendarCache?: Map<number, string>,
  ): Promise<void> {
    const channels = await this.getWorkspaceCalendarChannels(workspaceId);
    if (channels.length === 0) {
      return;
    }

    const hash = contentHash(eventInput);

    for (const channel of channels) {
      // Per-channel isolation: a failure (DB hiccup, provider error) on one
      // channel must never abort the push to the remaining channels.
      try {
        await this.syncItemToChannel(
          channel,
          item,
          workspaceId,
          eventInput,
          hash,
          primaryCalendarCache,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Calendar push isolated failure for ${describe(item)} on channel ${channel.id}: ${message}`,
        );
      }
    }
  }

  private async syncItemToChannel(
    channel: CalendarChannel,
    item: ItemRef,
    workspaceId: string,
    eventInput: EventInput,
    hash: string,
    primaryCalendarCache?: Map<number, string>,
  ): Promise<void> {
    const platform = channel.platform as CalendarPlatform;
    const { service, provider } = this.providerFor(platform);

    // Keep the per-channel pre-select AND the error-recording update inside the
    // isolating try/catch so a DB hiccup here can't abort the other channels.
    let existingLink: CalendarItemLink | undefined;

    try {
      [existingLink] = await db
        .select()
        .from(calendarItemLinks)
        .where(and(eq(calendarItemLinks.channelId, channel.id), ownerEq(item)));

      // Skip a no-op re-push (content unchanged + already synced) to avoid
      // needless writes + provider round-trips (also reduces echo churn).
      if (
        existingLink &&
        existingLink.lastPushedHash === hash &&
        existingLink.syncStatus === 'synced'
      ) {
        return;
      }

      const accessToken = await this.channelService.getAccessToken(
        channel.id,
        workspaceId,
      );

      if (existingLink) {
        const updated = await service.updateEvent(
          accessToken,
          existingLink.externalEventId,
          {
            summary: eventInput.summary,
            startTime: eventInput.startTime,
            endTime: eventInput.endTime,
            privateProps: eventInput.privateProps,
            ifMatch: existingLink.etag ?? undefined,
          },
          existingLink.externalCalendarId ?? 'primary',
        );

        await db
          .update(calendarItemLinks)
          .set({
            etag: updated.etag ?? existingLink.etag,
            lastPushedHash: hash,
            syncStatus: 'synced',
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(calendarItemLinks.id, existingLink.id));
      } else {
        // Resolve the channel's primary calendar id at most once per run
        // (memoized by channelId) instead of once per item — avoids an N+1
        // provider round-trip during backfill.
        let calendarId = primaryCalendarCache?.get(channel.id);
        if (!calendarId) {
          const primary = await service.getPrimaryCalendar(accessToken);
          calendarId = primary?.id ?? 'primary';
          primaryCalendarCache?.set(channel.id, calendarId);
        }
        const created = await service.createEvent(accessToken, {
          summary: eventInput.summary,
          startTime: eventInput.startTime,
          endTime: eventInput.endTime,
          privateProps: eventInput.privateProps,
          calendarId,
        });

        const row: NewCalendarItemLink = {
          workspaceId,
          channelId: channel.id,
          provider,
          postId: item.kind === 'post' ? item.postId : null,
          messageId: item.kind === 'message' ? item.messageId : null,
          externalEventId: created.id,
          externalCalendarId: calendarId,
          etag: created.etag ?? null,
          lastPushedHash: hash,
          syncStatus: 'synced',
        };
        await db.insert(calendarItemLinks).values(row);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Calendar push failed for ${describe(item)} on channel ${channel.id} (${platform}): ${message}`,
      );
      // Record the failure on the link when one exists so it can be retried/
      // surfaced; a failed create has no link to annotate.
      if (existingLink) {
        await db
          .update(calendarItemLinks)
          .set({
            syncStatus: 'error',
            lastError: message.slice(0, 1000),
            updatedAt: new Date(),
          })
          .where(eq(calendarItemLinks.id, existingLink.id));
      }
    }
  }

  // ==========================================================================
  // Removal
  // ==========================================================================

  /**
   * Delete the external event(s) for a post on every linked calendar and drop
   * the link rows. Swallows provider 404s (event already gone). Best-effort;
   * never throws.
   */
  async removePostEvent(postId: string): Promise<void> {
    const links = await db
      .select()
      .from(calendarItemLinks)
      .where(eq(calendarItemLinks.postId, postId));

    for (const link of links) {
      await this.removeLink(link);
    }
  }

  /**
   * Same, for a scheduled inbox message. Called whenever the message stops being
   * `pending` (cancelled / sent / failed) or its schedule is otherwise void.
   */
  async removeMessageEvent(messageId: string): Promise<void> {
    const links = await db
      .select()
      .from(calendarItemLinks)
      .where(eq(calendarItemLinks.messageId, messageId));

    for (const link of links) {
      await this.removeLink(link);
    }
  }

  /**
   * Remove a single link on the UN-schedule path (the item still exists, just no
   * longer schedulable). Only drop the `calendar_item_links` row when the
   * provider delete succeeds OR is a confirmed 404 (deleteEvent swallows those
   * internally, so a normal return === confirmed gone). On any transient error
   * (5xx/network/token) RETAIN the link and mark it `error` so a later reconcile
   * can retry — dropping it now would orphan a ghost event on the calendar.
   */
  private async removeLink(link: CalendarItemLink): Promise<void> {
    const platform =
      link.provider === 'google' ? 'google_calendar' : 'outlook_calendar';
    const { service } = this.providerFor(platform);
    try {
      const accessToken = await this.channelService.getAccessToken(
        link.channelId,
        link.workspaceId,
      );
      // deleteEvent already swallows provider 404s internally, so a normal
      // return means the event is confirmed gone (deleted or already absent).
      await service.deleteEvent(
        accessToken,
        link.externalEventId,
        link.externalCalendarId ?? 'primary',
      );
    } catch (error) {
      // Transient failure — keep the link for retry instead of orphaning it.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Calendar event delete failed for ${describeLink(link)} on channel ${link.channelId}; retaining link for retry: ${message}`,
      );
      await db
        .update(calendarItemLinks)
        .set({
          syncStatus: 'error',
          lastError: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(calendarItemLinks.id, link.id));
      return;
    }

    // Confirmed gone → safe to drop the link.
    await db.delete(calendarItemLinks).where(eq(calendarItemLinks.id, link.id));
  }

  /**
   * Load a post's calendar link rows into memory. Used by the post-DELETION
   * path so the external event ids survive the post's cascade delete of
   * `calendar_item_links` — the provider deletes only need the ids, not the
   * (soon-cascaded) rows. Fast DB read; the caller runs it BEFORE deleting the
   * post.
   */
  async loadPostLinks(postId: string): Promise<CalendarItemLink[]> {
    return db
      .select()
      .from(calendarItemLinks)
      .where(eq(calendarItemLinks.postId, postId));
  }

  /**
   * Best-effort provider-side deletion of events for already-detached links (the
   * item + its `calendar_item_links` are already gone via cascade). Fire this in
   * the BACKGROUND from the delete path so a slow/hanging provider API can never
   * stall or abort the delete. Never touches `calendar_item_links` (nothing to
   * reconcile) and never throws.
   */
  async deleteEventsForLinks(links: CalendarItemLink[]): Promise<void> {
    for (const link of links) {
      const platform =
        link.provider === 'google' ? 'google_calendar' : 'outlook_calendar';
      const { service } = this.providerFor(platform);
      try {
        const accessToken = await this.channelService.getAccessToken(
          link.channelId,
          link.workspaceId,
        );
        await service.deleteEvent(
          accessToken,
          link.externalEventId,
          link.externalCalendarId ?? 'primary',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Background calendar event delete failed for deleted ${describeLink(link)} on channel ${link.channelId}: ${message}`,
        );
      }
    }
  }

  /**
   * Assert the user owns or is an accepted member of the workspace before a
   * side-effecting workspace-scoped action. Mirrors the access rule used across
   * the app (inbox/workspace-members): workspace owner OR an ACCEPTED workspace
   * invitation. Throws ForbiddenException otherwise.
   */
  async assertWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const [owned] = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)));
    if (owned) return;

    const [member] = await db
      .select({ id: workspaceInvitation.id })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.userId, userId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      );
    if (!member) {
      throw new ForbiddenException('No access to this workspace');
    }
  }

  /**
   * Push every currently-scheduled future item (posts AND pending scheduled inbox
   * messages) of a workspace to its connected calendars. Called after a calendar
   * is connected (frontend/connect callback) so pre-existing scheduled items
   * appear. Per-item failures are isolated.
   */
  async backfillWorkspace(workspaceId: string): Promise<void> {
    const scheduled = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          gt(posts.scheduledAt, new Date()),
        ),
      );

    const messages = await db
      .select({ id: scheduledInboxMessages.id })
      .from(scheduledInboxMessages)
      .where(
        and(
          eq(scheduledInboxMessages.workspaceId, workspaceId),
          eq(scheduledInboxMessages.status, 'pending'),
          gt(scheduledInboxMessages.scheduledAt, new Date()),
        ),
      );

    this.logger.log(
      `Backfilling ${scheduled.length} scheduled post(s) + ${messages.length} scheduled message(s) for workspace ${workspaceId}`,
    );

    // Resolve each channel's primary calendar id at most once for the whole
    // backfill run (memoized by channelId) instead of once per item — avoids an
    // N+1 provider round-trip across many scheduled items.
    const primaryCalendarCache = new Map<number, string>();

    for (const { id } of scheduled) {
      try {
        await this.syncPost(id, primaryCalendarCache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Backfill syncPost failed for ${id}: ${message}`);
      }
    }

    for (const { id } of messages) {
      try {
        await this.syncMessage(id, primaryCalendarCache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Backfill syncMessage failed for ${id}: ${message}`);
      }
    }
  }

  /**
   * Active, connected calendar channels for a workspace.
   */
  private async getWorkspaceCalendarChannels(
    workspaceId: string,
  ): Promise<CalendarChannel[]> {
    return db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          inArray(socialMediaChannels.platform, [...CALENDAR_PLATFORMS]),
          eq(socialMediaChannels.isActive, true),
          eq(socialMediaChannels.connectionStatus, 'connected'),
        ),
      );
  }
}

/**
 * The owner predicate for a link lookup. The `IS NULL` half matters: without it
 * a post whose id happened to collide with a message id (or, more realistically,
 * a future third arc) could match the wrong row.
 */
function ownerEq(item: ItemRef) {
  return item.kind === 'post'
    ? and(
        eq(calendarItemLinks.postId, item.postId),
        isNull(calendarItemLinks.messageId),
      )
    : and(
        eq(calendarItemLinks.messageId, item.messageId),
        isNull(calendarItemLinks.postId),
      );
}

function describe(item: ItemRef): string {
  return item.kind === 'post'
    ? `post ${item.postId}`
    : `scheduled message ${item.messageId}`;
}

function describeLink(link: CalendarItemLink): string {
  return link.postId
    ? `post ${link.postId}`
    : `scheduled message ${link.messageId}`;
}
