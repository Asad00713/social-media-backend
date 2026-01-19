import { Injectable, Logger, BadRequestException } from '@nestjs/common';

// Platform colors for calendar events
const PLATFORM_COLORS: Record<string, string> = {
  facebook: '9', // Blue
  instagram: '6', // Orange
  twitter: '7', // Cyan
  linkedin: '1', // Blue
  youtube: '11', // Red
  tiktok: '2', // Green
  pinterest: '4', // Pink
  threads: '8', // Gray
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
}

export interface PostEventData {
  postId: string;
  platforms: string[];
  caption: string;
  scheduledAt: Date;
  mediaUrls?: string[];
  workspaceName?: string;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly apiBaseUrl = 'https://www.googleapis.com/calendar/v3';

  /**
   * List user's calendars
   */
  async listCalendars(accessToken: string): Promise<Calendar[]> {
    const response = await fetch(`${this.apiBaseUrl}/users/me/calendarList`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list calendars: ${error}`);
      throw new BadRequestException('Failed to list Google Calendars');
    }

    const data = await response.json();
    return data.items || [];
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
      timeZone = 'UTC',
      colorId,
      calendarId = 'primary',
    } = options;

    // Default event duration is 30 minutes
    const end = endTime || new Date(startTime.getTime() + 30 * 60 * 1000);

    const event = {
      summary,
      description,
      start: {
        dateTime: startTime.toISOString(),
        timeZone,
      },
      end: {
        dateTime: end.toISOString(),
        timeZone,
      },
      colorId,
    };

    const response = await fetch(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to create calendar event: ${error}`);
      throw new BadRequestException('Failed to create calendar event');
    }

    return response.json();
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
    // First get the existing event
    const existingEvent = await this.getEvent(accessToken, eventId, calendarId);

    const updatedEvent: Record<string, any> = {
      summary: updates.summary || existingEvent.summary,
      description: updates.description ?? existingEvent.description,
      start: existingEvent.start,
      end: existingEvent.end,
    };

    if (updates.startTime) {
      const endTime = updates.endTime || new Date(updates.startTime.getTime() + 30 * 60 * 1000);
      updatedEvent.start = {
        dateTime: updates.startTime.toISOString(),
        timeZone: updates.timeZone || 'UTC',
      };
      updatedEvent.end = {
        dateTime: endTime.toISOString(),
        timeZone: updates.timeZone || 'UTC',
      };
    }

    if (updates.colorId) {
      updatedEvent.colorId = updates.colorId;
    }

    const response = await fetch(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedEvent),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to update calendar event: ${error}`);
      throw new BadRequestException('Failed to update calendar event');
    }

    return response.json();
  }

  /**
   * Delete a calendar event
   */
  async deleteEvent(
    accessToken: string,
    eventId: string,
    calendarId: string = 'primary',
  ): Promise<void> {
    const response = await fetch(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

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
    const response = await fetch(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get calendar event: ${error}`);
      throw new BadRequestException('Failed to get calendar event');
    }

    return response.json();
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

    const params = new URLSearchParams({
      maxResults: maxResults.toString(),
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    if (timeMin) {
      params.append('timeMin', timeMin.toISOString());
    }
    if (timeMax) {
      params.append('timeMax', timeMax.toISOString());
    }
    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list calendar events: ${error}`);
      throw new BadRequestException('Failed to list calendar events');
    }

    const data = await response.json();
    return {
      events: data.items || [],
      nextPageToken: data.nextPageToken,
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
    const { postId, platforms, caption, scheduledAt, mediaUrls, workspaceName } = postData;

    // Build event summary with platform emojis
    const platformEmojis = this.getPlatformEmojis(platforms);
    const captionPreview = caption.length > 50 ? caption.substring(0, 50) + '...' : caption;
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

    // Use the first platform's color
    const colorId = PLATFORM_COLORS[platforms[0]] || '9';

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
        ? (postData.caption.length > 50 ? postData.caption.substring(0, 50) + '...' : postData.caption)
        : '';

      if (platformEmojis || captionPreview) {
        updates.summary = `${platformEmojis} ${captionPreview}`.trim();
      }
    }

    if (postData.scheduledAt) {
      updates.startTime = postData.scheduledAt;
    }

    if (postData.platforms && postData.platforms.length > 0) {
      updates.colorId = PLATFORM_COLORS[postData.platforms[0]] || '9';
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
      const response = await fetch(`${this.apiBaseUrl}/users/me/calendarList?maxResults=1`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
