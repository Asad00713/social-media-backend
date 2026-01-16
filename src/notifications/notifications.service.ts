import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import type { DbType } from 'src/drizzle/db';
import {
  notifications,
  Notification,
  NotificationType,
  NotificationPriority,
} from 'src/drizzle/schema';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { CreateNotificationDto } from './dto/create-notification.dto';

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  priority?: NotificationPriority;
  metadata?: Record<string, unknown>;
  actionUrl?: string;
}

export interface PaginatedNotifications {
  data: Notification[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  unreadCount: number;
}

@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  /**
   * Create a new notification
   */
  async create(params: CreateNotificationParams): Promise<Notification> {
    const [notification] = await this.db
      .insert(notifications)
      .values({
        userId: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        priority: params.priority || 'medium',
        metadata: params.metadata,
        actionUrl: params.actionUrl,
      })
      .returning();

    return notification;
  }

  /**
   * Get all notifications for a user (paginated)
   */
  async findAllByUser(
    userId: string,
    page: number = 1,
    limit: number = 20,
    unreadOnly: boolean = false,
  ): Promise<PaginatedNotifications> {
    const offset = (page - 1) * limit;

    const conditions = unreadOnly
      ? and(eq(notifications.userId, userId), eq(notifications.isRead, false))
      : eq(notifications.userId, userId);

    const notificationsList = await this.db.query.notifications.findMany({
      where: conditions,
      orderBy: [desc(notifications.createdAt)],
      limit,
      offset,
    });

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(conditions);

    const [{ unreadCount }] = await this.db
      .select({ unreadCount: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
      );

    return {
      data: notificationsList,
      pagination: {
        page,
        limit,
        total: Number(count),
        totalPages: Math.ceil(Number(count) / limit),
      },
      unreadCount: Number(unreadCount),
    };
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
      );

    return Number(count);
  }

  /**
   * Mark a single notification as read
   */
  async markAsRead(notificationId: string, userId: string): Promise<Notification | null> {
    const [updated] = await this.db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      )
      .returning();

    return updated || null;
  }

  /**
   * Mark multiple notifications as read
   */
  async markMultipleAsRead(notificationIds: string[], userId: string): Promise<number> {
    const result = await this.db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          inArray(notifications.id, notificationIds),
          eq(notifications.userId, userId),
        ),
      );

    return result.rowCount || 0;
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
      );

    return result.rowCount || 0;
  }

  /**
   * Delete a notification
   */
  async delete(notificationId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      );

    return (result.rowCount || 0) > 0;
  }

  /**
   * Delete all notifications for a user
   */
  async deleteAll(userId: string): Promise<number> {
    const result = await this.db
      .delete(notifications)
      .where(eq(notifications.userId, userId));

    return result.rowCount || 0;
  }

  // ==================== Helper Methods for Common Notifications ====================

  /**
   * Send notification to multiple users
   */
  async notifyUsers(
    userIds: string[],
    params: Omit<CreateNotificationParams, 'userId'>,
  ): Promise<Notification[]> {
    const notificationPromises = userIds.map((userId) =>
      this.create({ ...params, userId }),
    );
    return Promise.all(notificationPromises);
  }
}
