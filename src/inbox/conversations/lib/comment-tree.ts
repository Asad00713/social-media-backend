import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import { isContentRedacted } from '../../inbox.service';
import type { CommentActions, CommentNode, UserRef } from '../dto/contract';

/** The drizzle row type of `inbox_items`. */
export type CommentItemRecord = InboxItem;

/**
 * One node (`replies: []`). `parentId` is the parent's node id; a lone item
 * cannot resolve it, so callers that know it pass it (the tree builder does).
 */
export function commentNodeOf(
  item: CommentItemRecord,
  sentBy: UserRef | null,
  actions: CommentActions,
  parentId: string | null = null,
): CommentNode {
  const meta: Record<string, unknown> = item.metadata ?? {};
  return {
    id: item.id,
    parentId,
    author: {
      handle: item.authorHandle ?? '',
      displayName: item.authorDisplayName ?? null,
      avatarUrl: item.authorAvatarUrl ?? null,
    },
    text: item.text ?? '',
    at: item.platformCreatedAt.toISOString(),
    fromMe: item.fromMe,
    sentBy,
    unread: item.status === 'unread' && !item.fromMe,
    answered: item.repliedAt !== null,
    isHidden: item.isHidden,
    likeCount: typeof meta.likeCount === 'number' ? meta.likeCount : null,
    likedByUs: meta.likedByUs === true,
    contentRedacted: isContentRedacted(item),
    permalink: typeof meta.permalink === 'string' ? meta.permalink : null,
    actions,
    replies: [],
  };
}

/**
 * Roots (no parent in the set) oldest first; replies oldest first; unlimited
 * depth. Items link by `platformParentId` -> `platformItemId`. Linear time.
 */
export function buildCommentTree(
  items: CommentItemRecord[],
  users: Map<string, UserRef>,
  actionsFor: (item: CommentItemRecord) => CommentActions,
): CommentNode[] {
  const sorted = [...items].sort(
    (a, b) => a.platformCreatedAt.getTime() - b.platformCreatedAt.getTime(),
  );
  const byPlatformId = new Map<string, CommentItemRecord>();
  for (const it of sorted) byPlatformId.set(it.platformItemId, it);

  const nodes = new Map<string, CommentNode>();
  const roots: CommentNode[] = [];

  // Parents are resolved to the record first, so a cycle (a -> b -> a) or a
  // self-parent is detected by a bounded walk and treated as a root.
  const parentOf = (it: CommentItemRecord): CommentItemRecord | null => {
    if (!it.platformParentId) return null;
    const p = byPlatformId.get(it.platformParentId);
    if (!p || p.id === it.id) return null;
    return p;
  };
  const inCycle = (it: CommentItemRecord): boolean => {
    let cur: CommentItemRecord | null = parentOf(it);
    for (let i = 0; cur && i <= sorted.length; i++) {
      if (cur.id === it.id) return true;
      cur = parentOf(cur);
    }
    return false;
  };

  const parentFor = new Map<string, CommentItemRecord | null>();
  for (const it of sorted) {
    parentFor.set(it.id, inCycle(it) ? null : parentOf(it));
  }

  for (const it of sorted) {
    const parent = parentFor.get(it.id) ?? null;
    nodes.set(
      it.id,
      commentNodeOf(
        it,
        it.authoredByUserId ? (users.get(it.authoredByUserId) ?? null) : null,
        actionsFor(it),
        parent ? parent.id : null,
      ),
    );
  }
  // `sorted` is oldest first, so pushing in order keeps every level ordered.
  for (const it of sorted) {
    const node = nodes.get(it.id)!;
    const parent = parentFor.get(it.id);
    if (parent) nodes.get(parent.id)!.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
