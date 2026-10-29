import { NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { inboxConversations } from '../../../drizzle/schema/inbox-conversations.schema';
import { inboxItems } from '../../../drizzle/schema/inbox.schema';

export interface ReplyContext {
  platform: string;
  messages: { author: 'me' | 'customer'; text: string }[];
}

/** How many messages the model sees. */
export const REPLY_CONTEXT_LIMIT = 10;
/** Upper bound on the rows read to resolve a comment branch. */
const BRANCH_SCAN_LIMIT = 2000;

type ThreadRow = {
  id: string;
  platformItemId: string;
  platformParentId: string | null;
  platformCreatedAt: Date;
  fromMe: boolean;
  text: string | null;
};

/**
 * The thread an AI reply is drafted from, loaded on the server so a client
 * cannot feed the model text from a conversation it cannot read.
 *
 * Scoped by workspace on BOTH the conversation lookup and the item query (the
 * same thread_key can exist in two workspaces). dm / mention: the last 10
 * items. comment_thread: with `commentId` that comment's root and every reply
 * under it (last 10); without, the last 10 comments. Redacted (YouTube, null
 * text) and blank rows are skipped. Oldest first.
 */
export async function loadReplyContext(
  db: DbType,
  workspaceId: string,
  conversationId: string,
  commentId?: string,
): Promise<ReplyContext> {
  const [conv] = await db
    .select({
      kind: inboxConversations.kind,
      threadKey: inboxConversations.threadKey,
      platform: inboxConversations.platform,
    })
    .from(inboxConversations)
    .where(
      and(
        eq(inboxConversations.id, conversationId),
        eq(inboxConversations.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!conv) throw new NotFoundException('Conversation not found');

  // Hidden items (moderation) never reach the model, like redacted ones.
  const inThread = and(
    eq(inboxItems.workspaceId, workspaceId),
    eq(inboxItems.threadKey, conv.threadKey),
    eq(inboxItems.isHidden, false),
  );
  const columns = {
    id: inboxItems.id,
    platformItemId: inboxItems.platformItemId,
    platformParentId: inboxItems.platformParentId,
    platformCreatedAt: inboxItems.platformCreatedAt,
    fromMe: inboxItems.fromMe,
    text: inboxItems.text,
  };

  let rows: ThreadRow[];
  if (conv.kind === 'comment_thread' && commentId) {
    const all = await db
      .select(columns)
      .from(inboxItems)
      .where(and(inThread, eq(inboxItems.type, 'comment')))
      .orderBy(asc(inboxItems.platformCreatedAt))
      .limit(BRANCH_SCAN_LIMIT);
    const branch = branchOf(all, commentId);
    if (branch === null) throw new NotFoundException('Comment not found');
    rows = branch;
  } else {
    const hasText = and(
      isNotNull(inboxItems.text),
      sql`btrim(${inboxItems.text}) <> ''`,
    );
    const where =
      conv.kind === 'comment_thread'
        ? and(inThread, eq(inboxItems.type, 'comment'), hasText)
        : and(inThread, hasText);
    rows = await db
      .select(columns)
      .from(inboxItems)
      .where(where)
      .orderBy(desc(inboxItems.platformCreatedAt), desc(inboxItems.id))
      .limit(REPLY_CONTEXT_LIMIT);
  }

  const messages = rows
    .filter((r) => r.text !== null && r.text.trim() !== '')
    .sort(
      (a, b) =>
        a.platformCreatedAt.getTime() - b.platformCreatedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(-REPLY_CONTEXT_LIMIT)
    .map((r) => ({
      author: r.fromMe ? ('me' as const) : ('customer' as const),
      text: r.text as string,
    }));

  return { platform: conv.platform, messages };
}

/** The target's root plus all its descendants; null if the comment is absent. */
function branchOf(all: ThreadRow[], commentId: string): ThreadRow[] | null {
  const byPlatformId = new Map(all.map((r) => [r.platformItemId, r]));
  const target = all.find((r) => r.id === commentId);
  if (!target) return null;

  // Walk up to the root; the bounded loop survives a parent cycle.
  let root = target;
  for (let i = 0; i < all.length; i++) {
    const parent = root.platformParentId
      ? byPlatformId.get(root.platformParentId)
      : undefined;
    if (!parent || parent.id === target.id) break;
    root = parent;
  }

  const children = new Map<string, ThreadRow[]>();
  for (const r of all) {
    if (!r.platformParentId) continue;
    const list = children.get(r.platformParentId) ?? [];
    list.push(r);
    children.set(r.platformParentId, list);
  }
  const out: ThreadRow[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop() as ThreadRow;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push(cur);
    stack.push(...(children.get(cur.platformItemId) ?? []));
  }
  return out;
}
