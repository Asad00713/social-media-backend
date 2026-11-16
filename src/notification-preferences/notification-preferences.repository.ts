import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { notificationPreferences } from '../drizzle/schema/notification-preferences.schema';
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
}
