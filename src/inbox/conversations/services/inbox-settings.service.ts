import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  inboxUserSettings,
  type InboxDefaultLater,
  type InboxNotify,
  type InboxUserSettingsRow,
} from '../../../drizzle/schema/inbox-user-settings.schema';
import type { UpdateInboxSettingsDto } from '../dto/inbox-settings.dto';

export interface InboxSettings {
  markDoneOnReply: boolean;
  defaultLater: InboxDefaultLater;
  notify: InboxNotify;
  replyWindowWarnings: boolean;
  aiQuickReplies: boolean;
}

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  markDoneOnReply: true,
  defaultLater: 'tomorrow',
  notify: 'assigned_and_mentions',
  replyWindowWarnings: true,
  aiQuickReplies: true,
};

const KEYS = [
  'markDoneOnReply',
  'defaultLater',
  'notify',
  'replyWindowWarnings',
  'aiQuickReplies',
] as const;

function toSettings(row: InboxUserSettingsRow): InboxSettings {
  return {
    markDoneOnReply: row.markDoneOnReply,
    defaultLater: row.defaultLater,
    notify: row.notify,
    replyWindowWarnings: row.replyWindowWarnings,
    aiQuickReplies: row.aiQuickReplies,
  };
}

/** Per-person, per-workspace Inbox preferences. No row means defaults. */
@Injectable()
export class InboxSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async get(userId: string, workspaceId: string): Promise<InboxSettings> {
    const [row] = await this.db
      .select()
      .from(inboxUserSettings)
      .where(
        and(
          eq(inboxUserSettings.userId, userId),
          eq(inboxUserSettings.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ? toSettings(row) : { ...DEFAULT_INBOX_SETTINGS };
  }

  async getMany(
    userIds: string[],
    workspaceId: string,
  ): Promise<Map<string, InboxSettings>> {
    const out = new Map<string, InboxSettings>();
    if (userIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(inboxUserSettings)
      .where(
        and(
          eq(inboxUserSettings.workspaceId, workspaceId),
          inArray(inboxUserSettings.userId, userIds),
        ),
      );
    const byUser = new Map(rows.map((r) => [r.userId, toSettings(r)]));
    for (const id of userIds) {
      out.set(id, byUser.get(id) ?? { ...DEFAULT_INBOX_SETTINGS });
    }
    return out;
  }

  async update(
    userId: string,
    workspaceId: string,
    patch: UpdateInboxSettingsDto,
  ): Promise<InboxSettings> {
    const provided: Partial<InboxSettings> = {};
    for (const k of KEYS) {
      if (patch[k] !== undefined) {
        (provided as Record<string, unknown>)[k] = patch[k];
      }
    }
    if (Object.keys(provided).length === 0)
      return this.get(userId, workspaceId);

    const [row] = await this.db
      .insert(inboxUserSettings)
      .values({ userId, workspaceId, ...provided })
      .onConflictDoUpdate({
        target: [inboxUserSettings.userId, inboxUserSettings.workspaceId],
        set: { ...provided, updatedAt: sql`now()` },
      })
      .returning();
    return toSettings(row);
  }
}
