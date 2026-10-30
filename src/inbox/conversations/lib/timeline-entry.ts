import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import type { InboxNote } from '../../../drizzle/schema/inbox-notes.schema';
import type { ScheduledInboxMessage } from '../../../drizzle/schema/scheduled-inbox-messages.schema';
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

/** One internal note as a timeline entry; only its author may delete it. */
export function noteEntryOf(
  note: InboxNote,
  author: UserRef,
  mentions: UserRef[],
  viewerId: string,
): Extract<TimelineEntry, { kind: 'note' }> {
  return {
    kind: 'note',
    id: note.id,
    author,
    body: note.body,
    mentions,
    at: note.createdAt.toISOString(),
    canDelete: note.authorUserId !== null && note.authorUserId === viewerId,
  };
}

/**
 * A queued reply as a timeline entry. The contract exposes only `pending` and
 * `failed`; the in-flight `sending` state reads as pending.
 */
export function scheduledEntryOf(
  s: ScheduledInboxMessage,
  by: UserRef | null,
): Extract<TimelineEntry, { kind: 'scheduled' }> {
  return {
    kind: 'scheduled',
    id: s.id,
    text: s.text,
    attachments: s.attachments ?? [],
    sendAt: s.scheduledAt.toISOString(),
    by,
    status: s.status === 'failed' ? 'failed' : 'pending',
    error: s.errorMessage,
    parentItemId: s.parentItemId,
  };
}
