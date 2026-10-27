export type ConversationKind = 'comment_thread' | 'dm' | 'mention';

interface ThreadKeyInput {
  channelId: number;
  type: string;
  platformPostId: string | null;
  conversationId: string | null;
  platformItemId: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Mirrors the SQL expression of the generated `inbox_items.thread_key` column
 * (migration 0046) exactly. A mention is keyed by its PLATFORM item id, or by
 * `metadata.mentionRoot` for our replies to it, so a deleted and re-ingested
 * mention re-attaches to the same conversation.
 */
export function deriveThreadKey(r: ThreadKeyInput): string | null {
  if (r.type === 'dm') {
    return r.conversationId === null
      ? null
      : `${r.channelId}:${r.conversationId}`;
  }
  if (r.platformPostId !== null) return `${r.channelId}:${r.platformPostId}`;
  const root = r.metadata?.mentionRoot;
  return `${r.channelId}:mention:${typeof root === 'string' ? root : r.platformItemId}`;
}

export function kindOfItem(r: {
  type: string;
  platformPostId: string | null;
}): ConversationKind {
  if (r.type === 'dm') return 'dm';
  return r.platformPostId !== null ? 'comment_thread' : 'mention';
}
