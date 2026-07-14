import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { and, eq, gte, inArray, lte, notInArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { posts } from '../../drizzle/schema/posts.schema';
import {
  scheduledInboxMessages,
  type ScheduledInboxMessage,
} from '../../drizzle/schema/scheduled-inbox-messages.schema';
import {
  calendarItemLinks,
  CalendarItemLink,
  calendarSyncState,
  CalendarSyncStateRow,
  externalCalendarEvents,
} from '../../drizzle/schema/calendar-sync.schema';
import { ChannelService } from '../../channels/services/channel.service';
import {
  CalendarEvent,
  CreateEventOptions,
  GoogleCalendarService,
} from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import { CalendarPreconditionFailedError } from '../../channels/services/calendar-precondition.error';
import { PostService } from '../../posts/services/post.service';
import { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import { fetchGoogleCalendarDelta } from '../providers/google-delta.util';
import { fetchOutlookCalendarDelta } from '../providers/outlook-delta.util';
import {
  CalendarDeltaOptions,
  CalendarDeltaResult,
  NormalizedExternalEvent,
  fullSyncWindow,
} from '../providers/delta.types';
import { ConflictEvent, resolveConflict } from '../calendar-conflict';
import {
  EventInput,
  contentHash,
  messageToEventInput,
  postToEventInput,
} from '../calendar-sync.mapper';
import { CalendarPushSyncService } from './calendar-push-sync.service';

// Calendar channel platforms that participate in the pull (external import).
const CALENDAR_PLATFORMS = ['google_calendar', 'outlook_calendar'] as const;
type CalendarPlatform = (typeof CALENDAR_PLATFORMS)[number];
type Provider = 'google' | 'outlook';

type CalendarChannel = typeof socialMediaChannels.$inferSelect;
type Post = typeof posts.$inferSelect;

/**
 * The app-side item a link points at. Exactly one arc of `calendar_item_links`
 * is populated, so a loaded link resolves to exactly one of these.
 */
type LinkedItem =
  | { kind: 'post'; post: Post }
  | { kind: 'message'; message: ScheduledInboxMessage };

/**
 * Same guard the calendar UI applies when a user drags a post or a scheduled
 * reply: a reschedule must land in the future with enough lead time for the
 * publish/send job to be queued. (Matches `ScheduledMessagesService.MIN_LEAD_MS`.)
 */
const MIN_RESCHEDULE_LEAD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Max age of a full sync before we force a fresh one.
 *
 * Both providers' cursors (Google `syncToken`, Graph `deltaLink`) encode the
 * bounded window (`[now-30d, now+90d]`) that was in effect when the FULL list
 * ran, and they only reset on a 410. Left alone, a connection made in January
 * would still be streaming January's window in June, so nothing newly scheduled
 * would ever show up. Dropping the cursor every 7 days re-runs a bounded full
 * list, which rolls the window forward.
 */
const FULL_RESYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Minimal provider surface the write-back half needs. Both
// GoogleCalendarService and OutlookCalendarService satisfy this shape.
interface CalendarWriteService {
  getEvent(
    accessToken: string,
    eventId: string,
    calendarId?: string,
  ): Promise<CalendarEvent>;
  updateEvent(
    accessToken: string,
    eventId: string,
    updates: Partial<CreateEventOptions>,
    calendarId?: string,
  ): Promise<CalendarEvent>;
}

/**
 * CalendarPullSyncService — calendar→app pull (Task C: external import only).
 *
 * Runs an incremental delta against a connection's PRIMARY calendar and mirrors
 * the user's OTHER events (the ones we did NOT write) into
 * `external_calendar_events` so the unified calendar view can render them
 * read-only. Advances + persists the provider cursor
 * (Google `syncToken` / Graph `deltaLink`) on `calendar_sync_state`, and falls
 * back to a bounded full list whenever the provider rejects the stored cursor.
 *
 * Events carrying one of our ownership tags (`schedura_post_id` /
 * `schedura_message_id`) are the two-way write-back surface (Task D): each one is
 * matched to its `calendar_item_links` row, run through the pure
 * `resolveConflict()` engine, and applied — an external MOVE reschedules the
 * linked item, an external DELETE unschedules a post (→ draft) or CANCELS a
 * scheduled message, and an app-newer edit is re-pushed to the provider. Neither
 * a post nor a message is ever hard-deleted.
 *
 * `reconcile()` never throws: it is driven by BullMQ/webhooks where one broken
 * connection must not stall the others. Every per-event apply is likewise
 * isolated — one bad event must not abort the rest of the run.
 */
@Injectable()
export class CalendarPullSyncService {
  private readonly logger = new Logger(CalendarPullSyncService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly outlookCalendarService: OutlookCalendarService,
    private readonly pushSync: CalendarPushSyncService,
    // PostsModule ↔ CalendarSyncModule is a circular module pair (posts push to
    // calendars, calendars write back to posts) → forwardRef.
    @Inject(forwardRef(() => PostService))
    private readonly postService: PostService,
    // InboxModule ↔ CalendarSyncModule is circular for the same reason.
    @Inject(forwardRef(() => ScheduledMessagesService))
    private readonly scheduledMessages: ScheduledMessagesService,
    // RealtimeModule is @Global, so no module import is needed for this.
    private readonly events: AnalyticsEventEmitter,
  ) {}

  /**
   * Pull one calendar connection's delta and import its external events.
   * Idempotent + isolated: all failures are caught + logged, never rethrown.
   */
  async reconcile(channelId: number): Promise<void> {
    try {
      const channel = await this.loadCalendarChannel(channelId);
      if (!channel) {
        this.logger.debug(
          `reconcile: channel ${channelId} is not an active connected calendar channel, skipping`,
        );
        return;
      }

      const provider = this.providerFor(channel.platform as CalendarPlatform);
      const state = await this.getOrCreateSyncState(channelId, provider);

      const accessToken = await this.channelService.getAccessToken(
        channel.id,
        channel.workspaceId,
      );
      const calendarId = await this.resolvePrimaryCalendarId(
        provider,
        accessToken,
      );

      const now = new Date();

      let storedCursor =
        provider === 'google' ? state.syncToken : state.deltaLink;

      // The cursor freezes the bounded window it was minted with, so age it out
      // periodically and re-run a full list to roll the window forward.
      if (storedCursor && this.isFullResyncDue(state, now)) {
        this.logger.log(
          `Cursor for channel ${channelId} (${provider}) is older than ${FULL_RESYNC_MAX_AGE_MS / 86_400_000}d — forcing a bounded full resync to roll the sync window forward`,
        );
        await this.clearCursor(state.id, provider);
        storedCursor = null;
      }

      let isFullSync = !storedCursor;
      let delta = await this.runDelta(provider, {
        accessToken,
        calendarId,
        cursor: storedCursor,
        now,
      });

      // Provider rejected the stored cursor (Google 410 / Graph
      // syncStateNotFound) → drop it and re-run as a bounded full list.
      if (delta.needsFullResync) {
        this.logger.warn(
          `Cursor rejected for channel ${channelId} (${provider}) — clearing it and running a bounded full resync`,
        );
        await this.clearCursor(state.id, provider);
        isFullSync = true;
        delta = await this.runDelta(provider, {
          accessToken,
          calendarId,
          cursor: null,
          now,
        });

        // A full list must never itself demand another resync; if it does,
        // something is structurally wrong — bail rather than loop.
        if (delta.needsFullResync) {
          this.logger.error(
            `Full resync for channel ${channelId} (${provider}) also demanded a resync — aborting this run`,
          );
          return;
        }
      }

      const seenIds = await this.applyDelta(
        channel,
        provider,
        calendarId,
        delta,
      );

      // A TRUNCATED run (page cap hit) only saw a PREFIX of the provider's
      // stream, so:
      //  - pruning would delete events that were merely not fetched, and
      //  - the cursor must stay put (it is either absent, or still the previous
      //    one) so the next run re-reads what we missed.
      // Both are therefore skipped, and the run is not counted as a full sync.
      const isCompleteRun = !delta.truncated;

      // On a full resync the delta stream carries no tombstones, so anything we
      // previously imported inside the window that is no longer present is gone
      // (deleted while we were disconnected) → prune it.
      if (isFullSync && isCompleteRun) {
        await this.pruneMissingInWindow(channel.id, seenIds, now);
      }

      await this.persistCursor(
        state.id,
        provider,
        isCompleteRun ? delta.nextCursor : undefined,
        isFullSync && isCompleteRun,
      );

      this.logger.log(
        `Calendar pull for channel ${channelId} (${provider}): ${delta.changed.length} changed, ${delta.deleted.length} deleted, full=${isFullSync}, truncated=${delta.truncated}`,
      );

      // Tell any open calendar view to refetch. Without this the browser only
      // learns about a provider-side change when the tab regains focus, which is
      // why a Google event created in the next tab never appeared until reload.
      //
      // The signal is intentionally coarse — it fires on the raw delta, so an
      // event WE pushed and then read back echoes one redundant refetch. That is
      // the cheap direction to be wrong in: invalidateQueries only refetches
      // queries that are actually mounted, so a workspace with no calendar open
      // pays nothing, and we never miss a real change.
      if (delta.changed.length > 0 || delta.deleted.length > 0) {
        this.events.emit(channel.workspaceId, 'calendar.external.changed', {
          workspaceId: channel.workspaceId,
          channelId,
          provider,
          changed: delta.changed.length,
          deleted: delta.deleted.length,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Calendar pull failed for channel ${channelId}: ${message}`,
      );
    }
  }

  // ==========================================================================
  // Delta application
  // ==========================================================================

  /**
   * Upsert every NON-ours changed event, delete every tombstoned event.
   * Returns the set of external event ids we imported (used to prune after a
   * full resync).
   */
  private async applyDelta(
    channel: CalendarChannel,
    provider: Provider,
    calendarId: string,
    delta: CalendarDeltaResult,
  ): Promise<string[]> {
    // AUTHORITATIVE ownership check: an event is OURS when a
    // `calendar_item_links` row points at it, regardless of what the provider
    // payload says. This is not merely defence-in-depth — for Outlook it is the
    // ONLY signal, because Graph refuses `$expand` on its delta endpoints and so
    // never returns our MAPI ownership tags (`isOurs` is always false there).
    // Without this an event we wrote would be re-imported as an "external" event
    // and shown twice.
    const linkedIds = await this.loadLinkedEventIds(
      channel.id,
      delta.changed.map((event) => event.externalEventId),
    );

    const imported: string[] = [];

    for (const event of delta.changed) {
      if (event.isOurs || linkedIds.has(event.externalEventId)) {
        // OURS → two-way write-back (never imported as an external event).
        await this.applyOwnedChange(channel, event);
        continue;
      }
      await this.upsertExternalEvent(channel, provider, calendarId, event);
      imported.push(event.externalEventId);
    }

    if (delta.deleted.length > 0) {
      // Chunked so a large tombstone batch can't blow the bind-parameter limit.
      for (const chunk of chunkIds(delta.deleted, 200)) {
        await db
          .delete(externalCalendarEvents)
          .where(
            and(
              eq(externalCalendarEvents.channelId, channel.id),
              inArray(externalCalendarEvents.externalEventId, chunk),
            ),
          );
      }
      // A tombstone for an event WE wrote also unschedules the linked post.
      await this.applyOwnedDeletions(channel, delta.deleted);
    }

    return imported;
  }

  // ==========================================================================
  // Two-way write-back (events carrying one of our ownership tags)
  // ==========================================================================

  /**
   * Apply one inbound change to an event WE wrote. Isolated: any failure is
   * logged and swallowed so the rest of the delta still applies.
   *
   * The link decides which app-side item the event belongs to (post OR scheduled
   * message — an exclusive arc), and every branch below dispatches on that.
   */
  private async applyOwnedChange(
    channel: CalendarChannel,
    event: NormalizedExternalEvent,
  ): Promise<void> {
    try {
      const link = await this.loadLink(channel.id, event.externalEventId);
      if (!link) {
        // A tagged event we do not track (e.g. the user copied one of our events,
        // or a link row was pruned). Never touch what we do not own a link for.
        this.logger.debug(
          `Tagged event ${event.externalEventId} on channel ${channel.id} has no link row — skipping`,
        );
        return;
      }

      const item = await this.loadItem(link);
      if (!item) {
        // The item is gone (hard-deleted elsewhere) → the link is dead weight.
        await this.deleteLink(link.id);
        return;
      }

      const decision = resolveConflict({
        link,
        event: toConflictEvent(event),
        post: toConflictItem(item),
      });

      switch (decision) {
        case 'skip_echo':
        case 'noop':
          this.logger.debug(
            `Conflict for ${describeItem(item)} on channel ${channel.id}: ${decision}`,
          );
          return;
        case 'apply_external':
          await this.applyExternalMove(channel, link, item, event);
          return;
        case 'repush_app':
          await this.repushApp(channel, link, item, event.externalUpdatedAt);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Two-way write-back failed for event ${event.externalEventId} on channel ${channel.id}: ${message}`,
      );
    }
  }

  /**
   * Tombstones: a deleted event that is one of OURS unschedules its post back to
   * draft, or CANCELS its scheduled message. Neither row is ever deleted.
   */
  private async applyOwnedDeletions(
    channel: CalendarChannel,
    deletedIds: string[],
  ): Promise<void> {
    for (const chunk of chunkIds(deletedIds, 200)) {
      const links = await db
        .select()
        .from(calendarItemLinks)
        .where(
          and(
            eq(calendarItemLinks.channelId, channel.id),
            inArray(calendarItemLinks.externalEventId, chunk),
          ),
        );

      for (const link of links) {
        try {
          await this.applyExternalDelete(link);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `External-delete write-back failed for ${describeLink(link)} on channel ${channel.id}: ${message}`,
          );
        }
      }
    }
  }

  /**
   * External DELETE →
   *   - post:    back to draft/unscheduled via PostService's existing
   *              `updatePost({ scheduledAt: null })` path (which also cancels the
   *              queued publish job).
   *   - message: CANCELLED via ScheduledMessagesService's existing cancel path
   *              (status → 'cancelled' + the BullMQ delayed job removed).
   * NEVER a hard delete of either row.
   */
  private async applyExternalDelete(link: CalendarItemLink): Promise<void> {
    const item = await this.loadItem(link);
    if (!item) {
      await this.deleteLink(link.id);
      return;
    }

    // Route through the same engine (single source of truth for the truth table).
    const decision = resolveConflict({
      link,
      event: { deleted: true },
      post: toConflictItem(item),
    });
    if (decision !== 'apply_external') {
      return;
    }

    if (item.kind === 'post') {
      const post = item.post;
      if (post.status === 'scheduled') {
        // Reuses the existing unschedule path: status → 'draft', scheduledAt
        // cleared, BullMQ publish job cancelled. Its fire-and-forget calendar
        // push then removes the (now stale) events + links on every calendar.
        await this.postService.updatePost(
          post.id,
          post.workspaceId,
          post.createdById,
          { scheduledAt: null },
        );
        this.logger.log(
          `Post ${post.id} unscheduled → draft (its calendar event was deleted externally)`,
        );
      }
    } else {
      const message = item.message;
      if (message.status === 'pending') {
        // Reuses ScheduledMessagesService's cancel path (BullMQ delayed job
        // removed + status → 'cancelled' + realtime event). Never a hard delete.
        await this.scheduledMessages.cancelFromCalendar(
          message.workspaceId,
          message.id,
        );
        this.logger.log(
          `Scheduled message ${message.id} cancelled (its calendar event was deleted externally)`,
        );
      }
    }

    // Idempotent: the push path above may already have dropped it.
    await this.deleteLink(link.id);
  }

  /**
   * External MOVE → reschedule the linked item to the event's start through its
   * EXISTING app-side reschedule path (`PostService.updatePost({ scheduledAt })`
   * for posts, `ScheduledMessagesService.updateFromCalendar({ scheduledAt })` for
   * messages — the latter also re-arms the BullMQ delayed send job).
   *
   * Echo suppression: the link is stamped with the inbound etag AND the hash of
   * what we WOULD have pushed for the new time BEFORE the app update runs, so the
   * fire-and-forget push inside that update sees an unchanged hash and skips the
   * provider write entirely (no ping-pong, no 412 from a stale etag).
   */
  private async applyExternalMove(
    channel: CalendarChannel,
    link: CalendarItemLink,
    item: LinkedItem,
    event: ConflictEvent,
  ): Promise<void> {
    // The item is no longer schedulable (published/failed/draft, or a message
    // that is sending/sent/failed/cancelled) → the event is stale. Let the push
    // service reconcile it away instead of rescheduling.
    if (!isSchedulable(item)) {
      await this.resyncItem(item);
      return;
    }

    const newStart = event.startsAt;
    if (!newStart) return;

    // Same rule as the calendar drag-reschedule: must be far enough in the
    // future for the publish/send job. A violating move is NOT applied — we
    // surface it and re-push the app's real time so the calendar stops lying.
    if (newStart.getTime() - Date.now() < MIN_RESCHEDULE_LEAD_MS) {
      this.logger.warn(
        `Rejecting external move of ${describeItem(item)} to ${newStart.toISOString()}: must be at least 2 minutes in the future — re-pushing the app's schedule`,
      );
      await this.markLinkError(
        link.id,
        `External move to ${newStart.toISOString()} rejected: must be at least 2 minutes in the future`,
      );
      await this.repushApp(channel, link, item, event.externalUpdatedAt);
      return;
    }

    const pushedHash = contentHash(eventInputFor(item, newStart));

    // Stamp the link FIRST (see the doc comment above — this is what makes the
    // subsequent push a no-op instead of an echo).
    await this.updateLink(link.id, {
      etag: event.etag ?? link.etag,
      lastExternalUpdatedAt: event.externalUpdatedAt ?? new Date(),
      lastPushedHash: pushedHash,
      syncStatus: 'synced',
      lastError: null,
    });

    try {
      if (item.kind === 'post') {
        await this.postService.updatePost(
          item.post.id,
          item.post.workspaceId,
          item.post.createdById,
          { scheduledAt: newStart },
        );
      } else {
        await this.scheduledMessages.updateFromCalendar(
          item.message.workspaceId,
          item.message.id,
          { scheduledAt: newStart.toISOString() },
        );
      }
      this.logger.log(
        `${describeItem(item)} rescheduled to ${newStart.toISOString()} from an external calendar move (channel ${channel.id})`,
      );
    } catch (error) {
      // The item did not move → roll the link back so the next reconcile retries
      // rather than silently believing the two sides agree.
      const message = error instanceof Error ? error.message : String(error);
      await this.updateLink(link.id, {
        etag: link.etag,
        lastExternalUpdatedAt: link.lastExternalUpdatedAt,
        lastPushedHash: link.lastPushedHash,
        syncStatus: 'error',
        lastError: message.slice(0, 1000),
      });
      this.logger.warn(
        `Failed to apply external move to ${describeItem(item)}: ${message}`,
      );
    }
  }

  /**
   * App wins → rewrite the provider event from the app-side item, guarded by
   * `If-Match: link.etag`.
   *
   * On **412 Precondition Failed** the event changed under us: re-fetch it,
   * re-run `resolveConflict` ONCE, and apply that winner. A second 412 marks the
   * link `error` and gives up for this run (no retry loop).
   */
  private async repushApp(
    channel: CalendarChannel,
    link: CalendarItemLink,
    item: LinkedItem,
    externalUpdatedAt: Date | null | undefined,
    allowRefetch = true,
  ): Promise<void> {
    // Not schedulable anymore → the event should not exist at all; the push
    // service removes it (and the link) rather than us rewriting it.
    if (!isSchedulable(item)) {
      await this.resyncItem(item);
      return;
    }

    const service = this.writeServiceFor(channel.platform as CalendarPlatform);
    const eventInput = eventInputFor(item);
    const hash = contentHash(eventInput);

    const accessToken = await this.channelService.getAccessToken(
      channel.id,
      channel.workspaceId,
    );

    try {
      const updated = await service.updateEvent(
        accessToken,
        link.externalEventId,
        {
          summary: eventInput.summary,
          startTime: eventInput.startTime,
          endTime: eventInput.endTime,
          privateProps: eventInput.privateProps,
          ifMatch: link.etag ?? undefined,
        },
        link.externalCalendarId ?? 'primary',
      );

      // Stamp OUR write onto the link (etag + hash) → the delta echo of this very
      // write is recognised and skipped on the next pull. This is what closes the
      // ping-pong loop.
      await this.updateLink(link.id, {
        etag: updated.etag ?? link.etag,
        lastPushedHash: hash,
        lastExternalUpdatedAt: externalUpdatedAt ?? link.lastExternalUpdatedAt,
        syncStatus: 'synced',
        lastError: null,
      });
      this.logger.log(
        `Re-pushed ${describeItem(item)}'s schedule over an older external edit (channel ${channel.id})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (error instanceof CalendarPreconditionFailedError && allowRefetch) {
        await this.resolveAfterPrecondition(channel, link, item, service);
        return;
      }

      await this.markLinkError(link.id, message);
      this.logger.warn(
        `Re-push failed for ${describeItem(item)} on channel ${channel.id}: ${message}`,
      );
    }
  }

  /**
   * 412 fallback: re-fetch the live event, re-resolve the conflict ONCE and apply
   * the winner. A repush from here runs with `allowRefetch = false`, so a second
   * 412 ends in `syncStatus = 'error'` instead of looping.
   */
  private async resolveAfterPrecondition(
    channel: CalendarChannel,
    link: CalendarItemLink,
    item: LinkedItem,
    service: CalendarWriteService,
  ): Promise<void> {
    const accessToken = await this.channelService.getAccessToken(
      channel.id,
      channel.workspaceId,
    );
    const fresh = await service.getEvent(
      accessToken,
      link.externalEventId,
      link.externalCalendarId ?? 'primary',
    );
    const freshEvent = toConflictEventFromProvider(fresh);
    const freshLink: CalendarItemLink = {
      ...link,
      etag: freshEvent.etag ?? link.etag,
    };

    const decision = resolveConflict({
      link,
      event: freshEvent,
      post: toConflictItem(item),
    });
    this.logger.debug(
      `412 on ${describeItem(item)} (channel ${channel.id}) → re-resolved as ${decision}`,
    );

    switch (decision) {
      case 'skip_echo':
      case 'noop':
        // Nothing to write — just adopt the live etag so we stop 412-ing.
        await this.updateLink(link.id, {
          etag: freshLink.etag,
          lastExternalUpdatedAt:
            freshEvent.externalUpdatedAt ?? link.lastExternalUpdatedAt,
          syncStatus: 'synced',
          lastError: null,
        });
        return;
      case 'apply_external':
        await this.applyExternalMove(channel, freshLink, item, freshEvent);
        return;
      case 'repush_app':
        // ONE more attempt, now with the live etag. A 412 here → error + move on.
        await this.repushApp(
          channel,
          freshLink,
          item,
          freshEvent.externalUpdatedAt,
          false,
        );
        return;
    }
  }

  // ==========================================================================
  // Link + item helpers
  // ==========================================================================

  private async loadLink(
    channelId: number,
    externalEventId: string,
  ): Promise<CalendarItemLink | undefined> {
    const [link] = await db
      .select()
      .from(calendarItemLinks)
      .where(
        and(
          eq(calendarItemLinks.channelId, channelId),
          eq(calendarItemLinks.externalEventId, externalEventId),
        ),
      );
    return link;
  }

  /**
   * Resolve a link's exclusive arc to the app-side row it points at. Returns
   * null when that row no longer exists (→ the link is dead weight).
   */
  private async loadItem(link: CalendarItemLink): Promise<LinkedItem | null> {
    if (link.postId) {
      const post = await this.loadPost(link.postId);
      return post ? { kind: 'post', post } : null;
    }
    if (link.messageId) {
      const message = await this.loadMessage(link.messageId);
      return message ? { kind: 'message', message } : null;
    }
    // Unreachable while `cil_exactly_one_owner` holds; treat as dead weight.
    this.logger.warn(`Link ${link.id} has neither post_id nor message_id`);
    return null;
  }

  private async loadPost(postId: string): Promise<Post | undefined> {
    const [post] = await db.select().from(posts).where(eq(posts.id, postId));
    return post;
  }

  private async loadMessage(
    messageId: string,
  ): Promise<ScheduledInboxMessage | undefined> {
    const [message] = await db
      .select()
      .from(scheduledInboxMessages)
      .where(eq(scheduledInboxMessages.id, messageId));
    return message;
  }

  /** Re-run the push side for an item that should no longer have an event. */
  private async resyncItem(item: LinkedItem): Promise<void> {
    if (item.kind === 'post') {
      await this.pushSync.syncPost(item.post.id);
    } else {
      await this.pushSync.syncMessage(item.message.id);
    }
  }

  private async updateLink(
    linkId: string,
    set: Partial<{
      etag: string | null;
      lastPushedHash: string | null;
      lastExternalUpdatedAt: Date | null;
      syncStatus: string;
      lastError: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(calendarItemLinks)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(calendarItemLinks.id, linkId));
  }

  private async markLinkError(linkId: string, message: string): Promise<void> {
    await this.updateLink(linkId, {
      syncStatus: 'error',
      lastError: message.slice(0, 1000),
    });
  }

  private async deleteLink(linkId: string): Promise<void> {
    await db.delete(calendarItemLinks).where(eq(calendarItemLinks.id, linkId));
  }

  private writeServiceFor(platform: CalendarPlatform): CalendarWriteService {
    return platform === 'google_calendar'
      ? this.googleCalendarService
      : this.outlookCalendarService;
  }

  private async upsertExternalEvent(
    channel: CalendarChannel,
    provider: Provider,
    calendarId: string,
    event: NormalizedExternalEvent,
  ): Promise<void> {
    const values = {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      provider,
      externalCalendarId: event.calendarId || calendarId,
      externalEventId: event.externalEventId,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      isAllDay: event.isAllDay,
      htmlLink: event.htmlLink ?? null,
      externalUpdatedAt: event.externalUpdatedAt,
      raw: event.raw,
      fetchedAt: new Date(),
    };

    await db
      .insert(externalCalendarEvents)
      .values(values)
      .onConflictDoUpdate({
        target: [
          externalCalendarEvents.channelId,
          externalCalendarEvents.externalEventId,
        ],
        set: {
          provider: values.provider,
          externalCalendarId: values.externalCalendarId,
          title: values.title,
          startsAt: values.startsAt,
          endsAt: values.endsAt,
          isAllDay: values.isAllDay,
          htmlLink: values.htmlLink,
          externalUpdatedAt: values.externalUpdatedAt,
          raw: values.raw,
          fetchedAt: values.fetchedAt,
        },
      });
  }

  /**
   * After a bounded FULL list, drop the channel's previously-imported events
   * that fall inside the same window but were not returned this run.
   */
  private async pruneMissingInWindow(
    channelId: number,
    seenIds: string[],
    now: Date,
  ): Promise<void> {
    const { timeMin, timeMax } = fullSyncWindow(now);

    const inWindow = and(
      eq(externalCalendarEvents.channelId, channelId),
      gte(externalCalendarEvents.startsAt, timeMin),
      lte(externalCalendarEvents.startsAt, timeMax),
    );

    await db
      .delete(externalCalendarEvents)
      .where(
        seenIds.length > 0
          ? and(
              inWindow,
              notInArray(externalCalendarEvents.externalEventId, seenIds),
            )
          : inWindow,
      );
  }

  /**
   * External event ids of this channel that are already linked to one of our
   * items — a post OR a scheduled message (i.e. events WE wrote).
   */
  private async loadLinkedEventIds(
    channelId: number,
    externalEventIds: string[],
  ): Promise<Set<string>> {
    if (externalEventIds.length === 0) return new Set();

    const found = new Set<string>();
    for (const chunk of chunkIds(externalEventIds, 200)) {
      const rows = await db
        .select({ externalEventId: calendarItemLinks.externalEventId })
        .from(calendarItemLinks)
        .where(
          and(
            eq(calendarItemLinks.channelId, channelId),
            inArray(calendarItemLinks.externalEventId, chunk),
          ),
        );
      for (const row of rows) found.add(row.externalEventId);
    }
    return found;
  }

  // ==========================================================================
  // Provider plumbing
  // ==========================================================================

  private providerFor(platform: CalendarPlatform): Provider {
    return platform === 'google_calendar' ? 'google' : 'outlook';
  }

  private runDelta(
    provider: Provider,
    options: CalendarDeltaOptions,
  ): Promise<CalendarDeltaResult> {
    return provider === 'google'
      ? fetchGoogleCalendarDelta(options)
      : fetchOutlookCalendarDelta(options);
  }

  /**
   * v1 syncs the PRIMARY calendar only (one delta stream per connection).
   * Falls back to the provider's `'primary'` alias if the lookup returns nothing.
   */
  private async resolvePrimaryCalendarId(
    provider: Provider,
    accessToken: string,
  ): Promise<string> {
    const service =
      provider === 'google'
        ? this.googleCalendarService
        : this.outlookCalendarService;
    const primary = await service.getPrimaryCalendar(accessToken);
    return primary?.id ?? 'primary';
  }

  // ==========================================================================
  // Sync-state persistence
  // ==========================================================================

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

  private async getOrCreateSyncState(
    channelId: number,
    provider: Provider,
  ): Promise<CalendarSyncStateRow> {
    const [existing] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.channelId, channelId));
    if (existing) return existing;

    // Concurrent reconciles for the same channel can race here; the unique
    // constraint on channel_id makes the loser a no-op, then we re-read.
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

  /**
   * True when the connection's last bounded FULL list is older than
   * {@link FULL_RESYNC_MAX_AGE_MS} (or never happened) → the stored cursor is
   * still streaming a stale window and must be dropped.
   */
  private isFullResyncDue(state: CalendarSyncStateRow, now: Date): boolean {
    const lastFull = state.lastFullSyncAt;
    if (!lastFull) return true;
    return now.getTime() - lastFull.getTime() > FULL_RESYNC_MAX_AGE_MS;
  }

  private async clearCursor(
    stateId: string,
    provider: Provider,
  ): Promise<void> {
    await db
      .update(calendarSyncState)
      .set(
        provider === 'google'
          ? { syncToken: null, updatedAt: new Date() }
          : { deltaLink: null, updatedAt: new Date() },
      )
      .where(eq(calendarSyncState.id, stateId));
  }

  /**
   * Persist the fresh cursor + sync timestamps. A run that produced no cursor
   * (page cap hit) leaves the stored cursor untouched so nothing is skipped.
   */
  private async persistCursor(
    stateId: string,
    provider: Provider,
    nextCursor: string | undefined,
    isFullSync: boolean,
  ): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = {
      lastIncrementalSyncAt: now,
      updatedAt: now,
    };
    if (isFullSync) {
      set.lastFullSyncAt = now;
    }
    if (nextCursor) {
      if (provider === 'google') {
        set.syncToken = nextCursor;
      } else {
        set.deltaLink = nextCursor;
      }
    }

    await db
      .update(calendarSyncState)
      .set(set)
      .where(eq(calendarSyncState.id, stateId));
  }
}

// ============================================================================
// Item helpers (pure) — the post/message dispatch table in one place.
// ============================================================================

/** Only a still-scheduled item may carry a live calendar event. */
function isSchedulable(item: LinkedItem): boolean {
  return item.kind === 'post'
    ? item.post.status === 'scheduled' && !!item.post.scheduledAt
    : item.message.status === 'pending' && !!item.message.scheduledAt;
}

/**
 * The event body we WOULD push for this item (optionally at an overridden start,
 * used to pre-compute the echo-suppression hash before an external move lands).
 */
function eventInputFor(item: LinkedItem, startOverride?: Date): EventInput {
  if (item.kind === 'post') {
    return postToEventInput({
      id: item.post.id,
      workspaceId: item.post.workspaceId,
      content: item.post.content,
      scheduledAt: startOverride ?? item.post.scheduledAt,
    });
  }
  return messageToEventInput({
    id: item.message.id,
    workspaceId: item.message.workspaceId,
    text: item.message.text,
    targetLabel: item.message.targetLabel,
    scheduledAt: startOverride ?? item.message.scheduledAt,
  });
}

/**
 * The two fields the pure conflict engine needs from the app-side item
 * (`ConflictPost` is the historical name; it covers messages just the same).
 */
function toConflictItem(item: LinkedItem): {
  updatedAt: Date | null;
  scheduledAt: Date | null;
} {
  return item.kind === 'post'
    ? { updatedAt: item.post.updatedAt, scheduledAt: item.post.scheduledAt }
    : {
        updatedAt: item.message.updatedAt,
        scheduledAt: item.message.scheduledAt,
      };
}

function describeItem(item: LinkedItem): string {
  return item.kind === 'post'
    ? `post ${item.post.id}`
    : `scheduled message ${item.message.id}`;
}

function describeLink(link: CalendarItemLink): string {
  return link.postId
    ? `post ${link.postId}`
    : `scheduled message ${link.messageId}`;
}

/** Delta event → the pure conflict engine's input shape. */
function toConflictEvent(event: NormalizedExternalEvent): ConflictEvent {
  return {
    deleted: false,
    etag: event.etag ?? null,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    externalUpdatedAt: event.externalUpdatedAt,
  };
}

/**
 * Provider `getEvent()` response → conflict-engine input (used on the 412
 * re-fetch path). Google returns RFC3339 with an offset; Graph returns
 * offset-less UTC wall-clock + a separate `timeZone` — normalize both.
 */
function toConflictEventFromProvider(event: CalendarEvent): ConflictEvent {
  return {
    deleted: false,
    etag: event.etag ?? null,
    title: event.summary ?? '',
    startsAt: parseProviderDateTime(event.start),
    endsAt: parseProviderDateTime(event.end),
    externalUpdatedAt: event.updated ? toDateOrNull(event.updated) : null,
  };
}

function parseProviderDateTime(slot?: {
  dateTime?: string;
  timeZone?: string;
}): Date | null {
  if (!slot?.dateTime) return null;
  const value = slot.dateTime;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return toDateOrNull(hasZone ? value : `${value}Z`);
}

function toDateOrNull(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Split ids into bind-parameter-safe chunks. */
function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}
