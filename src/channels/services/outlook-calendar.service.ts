import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CalendarPreconditionFailedError } from './calendar-precondition.error';
import {
  GRAPH_POST_ID_PROP_ID,
  GRAPH_WORKSPACE_ID_PROP_ID,
  SCHEDURA_POST_ID_PROP,
  SCHEDURA_WORKSPACE_ID_PROP,
} from '../../calendar-sync/calendar-sync.constants';

// Platform categories for Outlook calendar events.
// Microsoft Graph events do not support Google's numeric colorId; instead they
// expose named "categories". We keep the same PLATFORM_COLORS map key surface
// (indexed by platform) so callers can pass a colorId for parity, but for Graph
// we translate the first platform into an event category label.
const PLATFORM_CATEGORIES: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitter: 'Twitter',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  threads: 'Threads',
};

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: {
    dateTime: string;
    timeZone?: string;
  };
  end: {
    dateTime: string;
    timeZone?: string;
  };
  colorId?: string;
  htmlLink?: string;
  status?: string;
  // Provider concurrency token (Graph `@odata.etag`). Used by calendar-sync for
  // If-Match guards + echo suppression.
  etag?: string;
  // Provider last-modified timestamp (Graph `lastModifiedDateTime`, ISO-8601 UTC).
  // Used by calendar-sync's conflict engine (last-write-wins).
  updated?: string;
}

export interface Calendar {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: string;
}

export interface CreateEventOptions {
  summary: string;
  description?: string;
  startTime: Date;
  endTime?: Date;
  timeZone?: string;
  colorId?: string;
  calendarId?: string;
  // Ownership tags. On Graph these are written as singleValueExtendedProperties
  // keyed by GRAPH_POST_ID_PROP_ID / GRAPH_WORKSPACE_ID_PROP_ID. Optional +
  // additive — existing callers unaffected.
  privateProps?: Record<string, string>;
  // Optional Graph changeKey/etag for optimistic concurrency on update (sent as
  // the `If-Match` header). Ignored on create.
  ifMatch?: string;
}

export interface PostEventData {
  postId: string;
  platforms: string[];
  caption: string;
  scheduledAt: Date;
  mediaUrls?: string[];
  workspaceName?: string;
}

/**
 * Microsoft Graph event shape (subset we consume).
 */
interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  lastModifiedDateTime?: string;
  subject?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  bodyPreview?: string;
  start?: {
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    timeZone?: string;
  };
  webLink?: string;
  categories?: string[];
}

/**
 * Microsoft Graph calendar shape (subset we consume).
 */
interface GraphCalendar {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  hexColor?: string;
  canEdit?: boolean;
}

/**
 * Outlook Calendar integration via Microsoft Graph.
 *
 * Mirrors {@link GoogleCalendarService} method-for-method (identical names,
 * signatures and return shapes) so the controller layer stays symmetric. All
 * requests go to Microsoft Graph (`/me/calendars`, `/me/events`) using the same
 * Bearer-token conventions as {@link OneDriveService}.
 */
@Injectable()
export class OutlookCalendarService {
  private readonly logger = new Logger(OutlookCalendarService.name);
  private readonly apiBaseUrl = 'https://graph.microsoft.com/v1.0';

  /**
   * List user's calendars
   */
  async listCalendars(accessToken: string): Promise<Calendar[]> {
    const response = await fetch(`${this.apiBaseUrl}/me/calendars`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list calendars: ${error}`);
      throw new BadRequestException('Failed to list Outlook Calendars');
    }

    const data = await response.json();
    return (data.value || []).map((cal: GraphCalendar) =>
      this.mapGraphCalendar(cal),
    );
  }

  /**
   * Get primary calendar
   */
  async getPrimaryCalendar(accessToken: string): Promise<Calendar | null> {
    const calendars = await this.listCalendars(accessToken);
    return calendars.find((cal) => cal.primary) || calendars[0] || null;
  }

  /**
   * Create a calendar event
   */
  async createEvent(
    accessToken: string,
    options: CreateEventOptions,
  ): Promise<CalendarEvent> {
    const {
      summary,
      description,
      startTime,
      endTime,
      colorId,
      calendarId = 'primary',
      privateProps,
    } = options;

    // Default event duration is 30 minutes
    const end = endTime || new Date(startTime.getTime() + 30 * 60 * 1000);

    const event: Record<string, any> = {
      subject: summary,
      body: {
        contentType: 'HTML',
        content: description || '',
      },
      // toGraphDateTime always emits UTC wall-clock (ISO with `Z` stripped),
      // so the paired timeZone is always UTC — ignore any caller-supplied
      // timeZone to avoid Graph double-interpreting the numeric as local time.
      start: {
        dateTime: this.toGraphDateTime(startTime),
        timeZone: 'UTC',
      },
      end: {
        dateTime: this.toGraphDateTime(end),
        timeZone: 'UTC',
      },
    };

    // Graph has no numeric colorId; map the caller's colorId to a named category.
    if (colorId) {
      event.categories = [colorId];
    }

    // Ownership tags → Graph singleValueExtendedProperties (named MAPI props).
    const svep = this.buildExtendedProps(privateProps);
    if (svep) {
      event.singleValueExtendedProperties = svep;
    }

    const response = await fetch(this.eventsPath(calendarId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to create calendar event: ${error}`);
      throw new BadRequestException('Failed to create calendar event');
    }

    return this.mapGraphEvent(await response.json());
  }

  /**
   * Update a calendar event
   */
  async updateEvent(
    accessToken: string,
    eventId: string,
    updates: Partial<CreateEventOptions>,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const patch: Record<string, any> = {};

    if (updates.summary !== undefined) {
      patch.subject = updates.summary;
    }

    if (updates.description !== undefined) {
      patch.body = {
        contentType: 'HTML',
        content: updates.description || '',
      };
    }

    if (updates.startTime) {
      const endTime =
        updates.endTime ||
        new Date(updates.startTime.getTime() + 30 * 60 * 1000);
      // toGraphDateTime always emits UTC wall-clock, so pair it with UTC and
      // ignore any caller-supplied timeZone (see createEvent).
      patch.start = {
        dateTime: this.toGraphDateTime(updates.startTime),
        timeZone: 'UTC',
      };
      patch.end = {
        dateTime: this.toGraphDateTime(endTime),
        timeZone: 'UTC',
      };
    }

    // Graph has no numeric colorId; map the caller's colorId to a named category.
    if (updates.colorId) {
      patch.categories = [updates.colorId];
    }

    // Re-assert ownership tags on update.
    const svep = this.buildExtendedProps(updates.privateProps);
    if (svep) {
      patch.singleValueExtendedProperties = svep;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    // Optimistic concurrency guard: Graph fails with 412 if the event changed.
    if (updates.ifMatch) {
      headers['If-Match'] = updates.ifMatch;
    }

    const response = await fetch(this.eventPath(eventId, calendarId), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to update calendar event: ${error}`);
      // The If-Match guard failed: the event changed remotely since we read it.
      // Surfaced as a distinct error so calendar-sync can re-fetch + re-resolve
      // instead of blindly retrying (all other statuses keep the old behaviour).
      if (response.status === 412) {
        throw new CalendarPreconditionFailedError('outlook', eventId);
      }
      throw new BadRequestException('Failed to update calendar event');
    }

    return this.mapGraphEvent(await response.json());
  }

  /**
   * Delete a calendar event
   */
  async deleteEvent(
    accessToken: string,
    eventId: string,
    calendarId: string = 'primary',
  ): Promise<void> {
    const response = await fetch(this.eventPath(eventId, calendarId), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      this.logger.error(`Failed to delete calendar event: ${error}`);
      throw new BadRequestException('Failed to delete calendar event');
    }
  }

  /**
   * Get a specific event
   */
  async getEvent(
    accessToken: string,
    eventId: string,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const response = await fetch(this.eventPath(eventId, calendarId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get calendar event: ${error}`);
      throw new BadRequestException('Failed to get calendar event');
    }

    return this.mapGraphEvent(await response.json());
  }

  /**
   * List events in a time range
   */
  async listEvents(
    accessToken: string,
    options: {
      calendarId?: string;
      timeMin?: Date;
      timeMax?: Date;
      maxResults?: number;
      pageToken?: string;
    } = {},
  ): Promise<{ events: CalendarEvent[]; nextPageToken?: string }> {
    const {
      calendarId = 'primary',
      timeMin,
      timeMax,
      maxResults = 50,
      pageToken,
    } = options;

    let url: string;
    if (pageToken) {
      // Graph pagination hands back a full @odata.nextLink URL.
      url = pageToken;
    } else if (timeMin && timeMax) {
      // Bounded range → calendarView (expands recurring events).
      const params = new URLSearchParams({
        startDateTime: timeMin.toISOString(),
        endDateTime: timeMax.toISOString(),
        $top: maxResults.toString(),
        $orderby: 'start/dateTime',
      });
      url = `${this.calendarBasePath(calendarId)}/calendarView?${params}`;
    } else {
      const params = new URLSearchParams({
        $top: maxResults.toString(),
        $orderby: 'start/dateTime',
      });
      url = `${this.calendarBasePath(calendarId)}/events?${params}`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list calendar events: ${error}`);
      throw new BadRequestException('Failed to list calendar events');
    }

    const data = await response.json();
    return {
      events: (data.value || []).map((evt: GraphEvent) =>
        this.mapGraphEvent(evt),
      ),
      nextPageToken: data['@odata.nextLink'],
    };
  }

  // ==========================================================================
  // Post-specific Calendar Operations
  // ==========================================================================

  /**
   * Create a calendar event for a scheduled post
   */
  async createPostEvent(
    accessToken: string,
    postData: PostEventData,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const {
      postId,
      platforms,
      caption,
      scheduledAt,
      mediaUrls,
      workspaceName,
    } = postData;

    // Build event summary with platform emojis
    const platformEmojis = this.getPlatformEmojis(platforms);
    const captionPreview =
      caption.length > 50 ? caption.substring(0, 50) + '...' : caption;
    const summary = `${platformEmojis} ${captionPreview}`;

    // Build description with full details
    const descriptionParts = [
      `📝 Caption:\n${caption}`,
      `\n📱 Platforms: ${platforms.join(', ')}`,
    ];

    if (workspaceName) {
      descriptionParts.push(`\n🏢 Workspace: ${workspaceName}`);
    }

    if (mediaUrls && mediaUrls.length > 0) {
      descriptionParts.push(`\n🖼️ Media: ${mediaUrls.length} file(s)`);
    }

    descriptionParts.push(`\n\n🔗 Post ID: ${postId}`);
    descriptionParts.push(`\n\n---\nManaged by Social Media Manager`);

    const description = descriptionParts.join('');

    // Use the first platform's category
    const colorId = PLATFORM_CATEGORIES[platforms[0]];

    return this.createEvent(accessToken, {
      summary,
      description,
      startTime: scheduledAt,
      colorId,
      calendarId,
    });
  }

  /**
   * Update a calendar event when post is modified
   */
  async updatePostEvent(
    accessToken: string,
    eventId: string,
    postData: Partial<PostEventData>,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const updates: Partial<CreateEventOptions> = {};

    if (postData.caption || postData.platforms) {
      const platformEmojis = postData.platforms
        ? this.getPlatformEmojis(postData.platforms)
        : '';
      const captionPreview = postData.caption
        ? postData.caption.length > 50
          ? postData.caption.substring(0, 50) + '...'
          : postData.caption
        : '';

      if (platformEmojis || captionPreview) {
        updates.summary = `${platformEmojis} ${captionPreview}`.trim();
      }
    }

    if (postData.scheduledAt) {
      updates.startTime = postData.scheduledAt;
    }

    if (postData.platforms && postData.platforms.length > 0) {
      updates.colorId = PLATFORM_CATEGORIES[postData.platforms[0]];
    }

    return this.updateEvent(accessToken, eventId, updates, calendarId);
  }

  /**
   * Mark a calendar event as published (update title)
   */
  async markEventAsPublished(
    accessToken: string,
    eventId: string,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const existingEvent = await this.getEvent(accessToken, eventId, calendarId);

    // Add checkmark to indicate published
    const newSummary = existingEvent.summary.startsWith('✅')
      ? existingEvent.summary
      : `✅ ${existingEvent.summary}`;

    return this.updateEvent(
      accessToken,
      eventId,
      { summary: newSummary },
      calendarId,
    );
  }

  /**
   * Mark a calendar event as failed
   */
  async markEventAsFailed(
    accessToken: string,
    eventId: string,
    calendarId: string = 'primary',
  ): Promise<CalendarEvent> {
    const existingEvent = await this.getEvent(accessToken, eventId, calendarId);

    // Add X to indicate failed
    const newSummary = existingEvent.summary.startsWith('❌')
      ? existingEvent.summary
      : `❌ ${existingEvent.summary}`;

    return this.updateEvent(
      accessToken,
      eventId,
      { summary: newSummary },
      calendarId,
    );
  }

  /**
   * Get platform emojis for event summary
   */
  private getPlatformEmojis(platforms: string[]): string {
    const emojiMap: Record<string, string> = {
      facebook: '📘',
      instagram: '📸',
      twitter: '🐦',
      linkedin: '💼',
      youtube: '▶️',
      tiktok: '🎵',
      pinterest: '📌',
      threads: '🧵',
    };

    return platforms.map((p) => emojiMap[p] || '📱').join('');
  }

  /**
   * Verify if the access token has Calendar scopes
   */
  async verifyAccess(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/me/calendars?$top=1`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Graph helpers
  // ==========================================================================

  /**
   * Base path for a calendar's collection endpoints. `primary` (or falsy) maps
   * to `/me`, otherwise a specific calendar under `/me/calendars/{id}`.
   */
  private calendarBasePath(calendarId?: string): string {
    if (!calendarId || calendarId === 'primary') {
      return `${this.apiBaseUrl}/me`;
    }
    return `${this.apiBaseUrl}/me/calendars/${encodeURIComponent(calendarId)}`;
  }

  /**
   * Path for creating/listing events on a calendar.
   */
  private eventsPath(calendarId?: string): string {
    return `${this.calendarBasePath(calendarId)}/events`;
  }

  /**
   * Path for a single event. Graph addresses events globally under
   * `/me/events/{id}` regardless of their parent calendar.
   */
  private eventPath(eventId: string, _calendarId?: string): string {
    return `${this.apiBaseUrl}/me/events/${encodeURIComponent(eventId)}`;
  }

  /**
   * Microsoft Graph carries the timezone separately in `timeZone`, so its
   * `dateTime` is ISO-8601 WITHOUT the trailing `Z`. We send UTC ISO and strip
   * the `Z`, pairing it with `timeZone: 'UTC'`.
   */
  private toGraphDateTime(date: Date): string {
    return date.toISOString().replace(/Z$/, '');
  }

  /**
   * Translate our generic `privateProps` map into Graph
   * singleValueExtendedProperties entries keyed by the fixed named MAPI
   * property GUIDs. Returns undefined when there is nothing to write.
   */
  private buildExtendedProps(
    privateProps?: Record<string, string>,
  ): Array<{ id: string; value: string }> | undefined {
    if (!privateProps) return undefined;
    const entries: Array<{ id: string; value: string }> = [];
    const postId = privateProps[SCHEDURA_POST_ID_PROP];
    if (postId) {
      entries.push({ id: GRAPH_POST_ID_PROP_ID, value: postId });
    }
    const workspaceId = privateProps[SCHEDURA_WORKSPACE_ID_PROP];
    if (workspaceId) {
      entries.push({ id: GRAPH_WORKSPACE_ID_PROP_ID, value: workspaceId });
    }
    return entries.length > 0 ? entries : undefined;
  }

  /**
   * Map a Microsoft Graph event to the Google-Calendar-shaped CalendarEvent so
   * the controller/consumers stay identical across both providers.
   */
  private mapGraphEvent(evt: GraphEvent): CalendarEvent {
    return {
      id: evt.id,
      summary: evt.subject || '',
      description: evt.body?.content ?? evt.bodyPreview,
      start: {
        dateTime: evt.start?.dateTime || '',
        timeZone: evt.start?.timeZone,
      },
      end: {
        dateTime: evt.end?.dateTime || '',
        timeZone: evt.end?.timeZone,
      },
      htmlLink: evt.webLink,
      etag: evt['@odata.etag'],
      updated: evt.lastModifiedDateTime,
    };
  }

  /**
   * Map a Microsoft Graph calendar to the Google-Calendar-shaped Calendar.
   */
  private mapGraphCalendar(cal: GraphCalendar): Calendar {
    return {
      id: cal.id,
      summary: cal.name || '',
      primary: cal.isDefaultCalendar,
      backgroundColor: cal.hexColor,
      accessRole: cal.canEdit ? 'writer' : 'reader',
    };
  }
}
