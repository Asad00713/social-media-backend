import type { ConversationRow, Platform, UserRef } from '../dto/contract';
import type { ConversationKind } from './thread-key';
import type { ConversationStatus, DoneVia } from './lifecycle';
import { replyWindowState } from './reply-window';

/** The conversation columns (camelCase) plus the joined display fields. */
export interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  threadKey: string;
  channelId: number;
  platform: string;
  status: ConversationStatus;
  title: string | null;
  participantName: string | null;
  participantHandle: string | null;
  participantAvatarUrl: string | null;
  thumbnailUrl: string | null;
  lastAuthorLabel: string | null;
  lastSnippet: string | null;
  lastFromMe: boolean;
  unreadCount: number;
  lastMessageAt: Date;
  assignedAt: Date | null;
  laterUntil: Date | null;
  laterUntilReply: boolean;
  doneAt: Date | null;
  doneVia: DoneVia | null;
  replyWindowClosesAt: Date | null;
  channelUsername: string | null;
  channelAccountName: string;
  assignee: UserRef | null;
  assignedBy: UserRef | null;
  doneBy: UserRef | null;
  scheduled: {
    id: string;
    sendAt: Date;
    by: UserRef | null;
    status: 'pending' | 'failed';
  } | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function presentRow(r: ConversationRecord, now: Date): ConversationRow {
  const isThread = r.kind === 'comment_thread';
  return {
    id: r.id,
    kind: r.kind,
    threadKey: r.threadKey,
    channelId: r.channelId,
    channelLabel: r.channelUsername
      ? r.channelUsername.replace(/^@/, '')
      : r.channelAccountName,
    platform: r.platform as Platform,
    status: r.status,
    title: r.title ?? r.participantName ?? r.participantHandle ?? '',
    avatarUrl: isThread ? null : r.participantAvatarUrl,
    thumbnailUrl: isThread ? r.thumbnailUrl : null,
    snippet: {
      authorLabel: r.lastAuthorLabel,
      text: r.lastSnippet ?? '',
      fromMe: r.lastFromMe,
    },
    unreadCount: r.unreadCount,
    lastMessageAt: r.lastMessageAt.toISOString(),
    assignee: r.assignee,
    assignedBy: r.assignedBy,
    assignedAt: iso(r.assignedAt),
    laterUntil: iso(r.laterUntil),
    laterUntilReply: r.laterUntilReply,
    doneBy: r.doneBy,
    doneAt: iso(r.doneAt),
    doneVia: r.doneVia,
    replyWindow: {
      closesAt: iso(r.replyWindowClosesAt),
      state: replyWindowState(r.replyWindowClosesAt, now),
    },
    scheduled: r.scheduled
      ? {
          id: r.scheduled.id,
          sendAt: r.scheduled.sendAt.toISOString(),
          by: r.scheduled.by,
          status: r.scheduled.status,
        }
      : null,
    contentRedacted: r.platform === 'youtube' && r.lastSnippet === null,
  };
}
