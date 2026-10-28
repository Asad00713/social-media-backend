import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { inboxItems } from '../drizzle/schema/inbox.schema';

export interface LegacyInboxCounts {
  perChannel: { channelId: number; comments: number; dms: number }[];
  smartFolders: {
    all: number;
    unread: number;
    needs_reply: number;
    done: number;
  };
  total: number;
}

/**
 * The pre-redesign badge counts (channel badges + smart folders), moved out of
 * InboxService verbatim so the realtime service can emit them too (R1).
 */
export async function computeLegacyCounts(
  db: DbType,
  workspaceId: string,
): Promise<LegacyInboxCounts> {
  // Per-channel unread comment counts
  const perChannelRows = await db
    .select({
      channelId: inboxItems.channelId,
      comments: sql<number>`count(*) filter (where ${inboxItems.type} = 'comment' and ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
      dms: sql<number>`count(*) filter (where ${inboxItems.type} = 'dm' and ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspaceId),
        // Archived (inbox-deleted) rows must not count toward badges.
        isNull(inboxItems.archivedAt),
      ),
    )
    .groupBy(inboxItems.channelId);

  const folderRows = await db
    .select({
      all: sql<number>`count(*)`,
      unread: sql<number>`count(*) filter (where ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
      needs_reply: sql<number>`count(*) filter (where ${inboxItems.status} = 'needs_reply')`,
      done: sql<number>`count(*) filter (where ${inboxItems.status} = 'done')`,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspaceId),
        eq(inboxItems.type, 'comment'),
        isNull(inboxItems.archivedAt),
      ),
    );

  const folder = folderRows[0] ?? {
    all: 0,
    unread: 0,
    needs_reply: 0,
    done: 0,
  };

  const perChannel = perChannelRows.map((r) => ({
    channelId: r.channelId,
    comments: Number(r.comments),
    dms: Number(r.dms),
  }));

  return {
    perChannel,
    smartFolders: {
      all: Number(folder.all),
      unread: Number(folder.unread),
      needs_reply: Number(folder.needs_reply),
      done: Number(folder.done),
    },
    total: perChannel.reduce((acc, r) => acc + r.comments + r.dms, 0),
  };
}
