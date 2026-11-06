import { Injectable } from '@nestjs/common';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { reminderText, type ReminderContent } from '../lib/reminder';

export interface SendReminderInput {
  /** Who gets it: the person the publish runs as (the post's creator). */
  userId: string;
  workspaceId: string;
  postId: string;
  channelId: string;
  content: ReminderContent;
}

/**
 * Sends a "Remind me" post's reminder: an in-app notification (bell +
 * websocket) carrying the caption, the media links and the frame note.
 *
 * In-app only. The product sends no post-related email today, and Figma's
 * "phone reminder" would need a push channel the product does not have.
 */
@Injectable()
export class PostReminderService {
  constructor(private readonly notifications: NotificationEmitterService) {}

  async send(input: SendReminderInput): Promise<void> {
    const { title, message } = reminderText(input.content);
    await this.notifications.postReminder(input.userId, {
      workspaceId: input.workspaceId,
      postId: input.postId,
      channelId: input.channelId,
      platform: input.content.platform,
      title,
      message,
      mediaUrls: input.content.mediaUrls,
      note: input.content.note,
    });
  }
}
