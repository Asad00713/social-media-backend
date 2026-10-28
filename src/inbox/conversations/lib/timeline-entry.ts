import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import type { Attachment, TimelineEntry, UserRef } from '../dto/contract';

type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;

const KINDS: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
  'voice',
  'file',
]);

function attachmentsOf(metadata: InboxItem['metadata']): Attachment[] {
  const raw = (metadata as Record<string, unknown> | null)?.attachments;
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const { kind, url, contentType, thumbnailUrl } = a as Record<
      string,
      unknown
    >;
    if (typeof url !== 'string' || typeof kind !== 'string') continue;
    if (!KINDS.has(kind)) continue;
    out.push({
      kind: kind as Attachment['kind'],
      url,
      contentType: typeof contentType === 'string' ? contentType : null,
      thumbnailUrl: typeof thumbnailUrl === 'string' ? thumbnailUrl : null,
    });
  }
  return out;
}

/** One dm row as a conversation-timeline message entry (contract shape). */
export function messageEntryOf(
  item: InboxItem,
  sentBy: UserRef | null,
  canDelete: boolean,
): MessageEntry {
  return {
    kind: 'message',
    id: item.id,
    from: item.fromMe ? 'me' : 'them',
    author: {
      handle: item.authorHandle ?? '',
      displayName: item.authorDisplayName,
      avatarUrl: item.authorAvatarUrl,
    },
    text: item.text ?? '',
    at: item.platformCreatedAt.toISOString(),
    attachments: attachmentsOf(item.metadata),
    sentBy,
    canDelete,
  };
}
