import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { notificationRoutes, socialMediaChannels } from '../drizzle/schema';
import type {
  CreateNotificationRouteDto,
  UpdateNotificationRouteDto,
} from './dto/notification-route.dto';

@Injectable()
export class NotificationRoutesService {
  list(workspaceId: string) {
    return db
      .select()
      .from(notificationRoutes)
      .where(eq(notificationRoutes.workspaceId, workspaceId));
  }

  async create(workspaceId: string, dto: CreateNotificationRouteDto) {
    // Verify the destination channel belongs to this workspace before binding.
    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, dto.channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!channel)
      throw new ForbiddenException('Channel does not belong to this workspace');

    const [row] = await db
      .insert(notificationRoutes)
      .values({
        workspaceId,
        eventType: dto.eventType,
        channelId: dto.channelId,
        targetPlatformChannelId: dto.targetPlatformChannelId,
        targetDisplayName: dto.targetDisplayName ?? null,
        enabled: dto.enabled ?? true,
      })
      .returning();
    return row;
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateNotificationRouteDto,
  ) {
    const [existing] = await db
      .select()
      .from(notificationRoutes)
      .where(
        and(
          eq(notificationRoutes.id, id),
          eq(notificationRoutes.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Route not found');

    const [row] = await db
      .update(notificationRoutes)
      .set({
        ...(dto.eventType !== undefined ? { eventType: dto.eventType } : {}),
        ...(dto.channelId !== undefined ? { channelId: dto.channelId } : {}),
        ...(dto.targetPlatformChannelId !== undefined
          ? { targetPlatformChannelId: dto.targetPlatformChannelId }
          : {}),
        ...(dto.targetDisplayName !== undefined
          ? { targetDisplayName: dto.targetDisplayName }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(notificationRoutes.id, id))
      .returning();
    return row;
  }

  async delete(workspaceId: string, id: string) {
    const result = await db
      .delete(notificationRoutes)
      .where(
        and(
          eq(notificationRoutes.id, id),
          eq(notificationRoutes.workspaceId, workspaceId),
        ),
      )
      .returning();
    if (result.length === 0) throw new NotFoundException('Route not found');
    return { ok: true };
  }

  /** Used by the dispatcher to find all enabled routes for a given event. */
  forEvent(workspaceId: string, eventType: string) {
    return db
      .select()
      .from(notificationRoutes)
      .where(
        and(
          eq(notificationRoutes.workspaceId, workspaceId),
          eq(notificationRoutes.eventType, eventType),
          eq(notificationRoutes.enabled, true),
        ),
      );
  }
}
