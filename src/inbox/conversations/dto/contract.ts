/**
 * Inbox API contract, copied from
 * socialmedia-frontend/docs/superpowers/specs/2026-10-26-inbox-api-contract.md.
 * Names and fields match the contract exactly. Types already declared by the
 * lifecycle / thread-key / undo / settings modules are re-exported, never
 * redeclared (D14, D15).
 */
import type { ConversationKind } from '../lib/thread-key';
import type { ConversationStatus, DoneVia } from '../lib/lifecycle';
import type { PatchConversationBody } from '../lib/undo';
import type { LaterPreset } from '../lib/later-presets';
import type { InboxSettings } from '../services/inbox-settings.service';

export type { ConversationKind, ConversationStatus, DoneVia };
export type { PatchConversationBody };
export type { InboxSettings };
export { DEFAULT_INBOX_SETTINGS } from '../services/inbox-settings.service';

export type InboxView = 'to_reply' | 'later' | 'done' | 'scheduled';
export type InboxType = 'all' | 'message' | 'comment' | 'mention'; // message = dm
export type InboxSort = 'newest' | 'oldest' | 'window'; // window = closing first
export type Platform =
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'youtube'
  | 'bluesky'
  | 'mastodon'
  | 'whatsapp'
  | 'telegram'
  | 'discord'
  | 'slack';

export interface UserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ReplyWindow {
  closesAt: string | null; // null = no window on this platform
  state: 'none' | 'open' | 'closing' | 'closed'; // closing = under 1 hour left
}

/**
 * When not allowed: a set `reason` shows the action greyed with that reason;
 * no `reason` hides it.
 */
export interface ActionFlag {
  allowed: boolean;
  reason?: string;
}

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  threadKey: string;
  channelId: number;
  channelLabel: string;
  platform: Platform;
  status: ConversationStatus;
  title: string;
  avatarUrl: string | null;
  thumbnailUrl: string | null;
  snippet: { authorLabel: string | null; text: string; fromMe: boolean };
  unreadCount: number;
  lastMessageAt: string;
  assignee: UserRef | null;
  assignedBy: UserRef | null;
  assignedAt: string | null;
  laterUntil: string | null;
  laterUntilReply: boolean;
  doneBy: UserRef | null;
  doneAt: string | null;
  doneVia: DoneVia | null;
  replyWindow: ReplyWindow;
  scheduled: {
    id: string;
    sendAt: string;
    by: UserRef | null;
    status: 'pending' | 'failed';
  } | null;
  contentRedacted: boolean;
}

export interface ListConversationsQuery {
  view: InboxView;
  type?: InboxType;
  q?: string;
  channelIds?: number[];
  assigned?: 'me' | 'unassigned';
  unread?: boolean;
  sort?: InboxSort;
  cursor?: string;
  limit?: number;
}

export interface ListConversationsResponse {
  rows: ConversationRow[];
  nextCursor: string | null;
  total: number;
}

export interface InboxCounts {
  toReply: number;
  later: number;
  scheduled: number;
  answeredToday: { total: number; by: UserRef[] };
}

export interface CommentActions {
  reply: ActionFlag;
  like: ActionFlag;
  hide: ActionFlag;
  delete: ActionFlag;
  privateReply: ActionFlag;
}

export interface CommentNode {
  id: string;
  parentId: string | null;
  author: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  text: string;
  at: string;
  fromMe: boolean;
  sentBy: UserRef | null;
  unread: boolean;
  answered: boolean;
  isHidden: boolean;
  likeCount: number | null;
  likedByUs: boolean;
  contentRedacted: boolean;
  permalink: string | null;
  actions: CommentActions;
  replies: CommentNode[];
}

export interface Attachment {
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  url: string;
  contentType: string | null;
  thumbnailUrl: string | null;
}

export type TimelineEntry =
  | {
      kind: 'message';
      id: string;
      from: 'them' | 'me';
      author: {
        handle: string;
        displayName: string | null;
        avatarUrl: string | null;
      };
      text: string;
      at: string;
      attachments: Attachment[];
      sentBy: UserRef | null;
      canDelete: boolean;
    }
  | {
      kind: 'note';
      id: string;
      author: UserRef;
      body: string;
      mentions: UserRef[];
      at: string;
      canDelete: boolean;
    }
  | {
      kind: 'scheduled';
      id: string;
      text: string;
      attachments: Attachment[];
      sendAt: string;
      by: UserRef | null;
      status: 'pending' | 'failed';
      error: string | null;
      parentItemId: string | null;
    };

export interface ConversationDetail {
  row: ConversationRow;
  participant: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
  } | null;
  post: {
    id: string | null;
    caption: string | null;
    thumbnailUrl: string | null;
    mediaType: 'image' | 'video' | 'none';
    publishedAt: string | null;
    platformPostUrl: string | null;
    surfaceLabel: string;
    campaign: { id: string; name: string; dayLabel: string | null } | null;
    answered: { answered: number; total: number };
    likes: number | null;
  } | null;
  mention: {
    text: string;
    permalink: string | null;
    likes: number | null;
    replies: number | null;
  } | null;
  comments: CommentNode[] | null;
  timeline: TimelineEntry[];
  latestSendLaterAt: string | null;
  canSendLater: boolean;
}

export interface MutationResult {
  row: ConversationRow;
  undo: PatchConversationBody | null;
}

export interface BulkBody {
  ids: string[];
  action: 'done' | 'later' | 'assign' | 'unread';
  laterUntil?: string;
  laterPreset?: LaterPreset;
  laterUntilReply?: boolean;
  assigneeUserId?: string | null;
}

export interface BulkResult {
  rows: ConversationRow[];
  undo: { ids: string[]; previous: Record<string, PatchConversationBody> };
}

export interface ProfileStats {
  firstMessageAt: string | null;
  conversations: number;
  commentsOnOurPosts: number;
  recent: { label: string; at: string; conversationId: string | null }[];
}

/**
 * The contract's superset: every field the legacy scheduled-message DTO
 * returns (the Planner keeps reading them) plus the new ones.
 */
export interface ScheduledDto {
  id: string;
  workspaceId: string;
  channelId: number;
  type: 'comment' | 'dm';
  threadKey: string;
  parentItemId: string | null;
  platformPostId: string | null;
  conversationId: string | null; // the platform conversation id, as today
  targetLabel: string | null;
  text: string;
  textPreview?: string;
  scheduledAt: string;
  timezone: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  errorMessage: string | null;
  platform?: string;
  // legacy fields still returned by the old DTO
  createdByUserId: string | null;
  sentInboxItemId: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  // new fields
  inboxConversationId: string;
  sendAt: string; // = scheduledAt
  by: UserRef | null;
  attachments: Attachment[];
  error: string | null; // = errorMessage
}

export interface SavedReply {
  id: string;
  name: string;
  shortcut: string;
  body: string;
  usageCount: number;
  createdBy: UserRef | null;
  updatedAt: string;
}

export type SendFailureCode =
  | 'REPLY_WINDOW_CLOSED'
  | 'CHANNEL_DISCONNECTED'
  | 'RATE_LIMITED'
  | 'PLATFORM_ERROR'
  | 'REPLIED_FIRST';

// Realtime (socket.io, room `workspace:<id>`)
export interface ConversationUpsertedEvent {
  workspaceId: string;
  row: ConversationRow;
}
export interface ConversationRemovedEvent {
  workspaceId: string;
  id: string;
}
/** Event name: 'inbox.conversation.counts.changed'. */
export interface ConversationCountsChangedEvent {
  workspaceId: string;
  counts: InboxCounts;
}
export interface TimelineAppendedEvent {
  workspaceId: string;
  conversationId: string;
  entry: TimelineEntry | null; // the client refetches detail when null
  commentId: string | null;
}
export interface TypingEvent {
  workspaceId: string;
  conversationId: string;
  user: UserRef;
  state: 'start' | 'stop';
}
/** client -> server, event name 'inbox:typing'. */
export interface TypingClientEvent {
  workspaceId: string;
  conversationId: string;
  state: 'start' | 'stop';
}
