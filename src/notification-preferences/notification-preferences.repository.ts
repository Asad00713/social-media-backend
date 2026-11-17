import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { notificationPreferences } from '../drizzle/schema/notification-preferences.schema';
import { users } from '../drizzle/schema/users.schema';
import type { PreferenceChannel } from './notification-events';

export interface PreferenceOverride {
  event: string;
  channel: string;
  enabled: boolean;
}

@Injectable()
export class NotificationPreferencesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** The user's override rows in one workspace, or the account-level ones. */
  findForUser(
    userId: string,
    workspaceId: string | null,
  ): Promise<PreferenceOverride[]> {
    return this.db
      .select({
        event: notificationPreferences.event,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          workspaceId === null
            ? isNull(notificationPreferences.workspaceId)
            : eq(notificationPreferences.workspaceId, workspaceId),
        ),
      );
  }

  /**
   * Insert or update one override. The conflict target is the partial unique
   * index that matches the row: workspace rows and account-level rows (NULL
   * workspace) each have their own.
   */
  async upsert(
    userId: string,
    workspaceId: string | null,
    event: string,
    channel: PreferenceChannel,
    enabled: boolean,
  ): Promise<void> {
    const p = notificationPreferences;
    const values = { userId, workspaceId, event, channel, enabled };
    const set = { enabled, updatedAt: sql`now()` };
    if (workspaceId === null) {
      await this.db
        .insert(p)
        .values(values)
        .onConflictDoUpdate({
          target: [p.userId, p.event, p.channel],
          targetWhere: sql`${p.workspaceId} is null`,
          set,
        });
      return;
    }
    await this.db
      .insert(p)
      .values(values)
      .onConflictDoUpdate({
        target: [p.userId, p.workspaceId, p.event, p.channel],
        targetWhere: sql`${p.workspaceId} is not null`,
        set,
      });
  }

  /** When the user's notification pause ends; null if never set or cleared. */
  async pausedUntil(userId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ until: users.notificationsPausedUntil })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.until ?? null;
  }

  /** Sets the pause end, or clears it with null. */
  async setPausedUntil(userId: string, until: Date | null): Promise<void> {
    await this.db
      .update(users)
      .set({ notificationsPausedUntil: until })
      .where(eq(users.id, userId));
  }
}
