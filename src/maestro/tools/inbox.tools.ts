import { z } from 'zod';
import type {
  CommentNode,
  ConversationDetail,
  ConversationRow,
  InboxType,
  InboxView,
} from '../../inbox/conversations/dto/contract';
import type { ListConversationsQueryDto } from '../../inbox/conversations/dto/list-conversations.query';
import type { ConversationDetailService } from '../../inbox/conversations/services/conversation-detail.service';
import type { ConversationListService } from '../../inbox/conversations/services/conversation-list.service';
import type { ConversationPresenter } from '../../inbox/conversations/services/conversation-presenter.service';
import type { AgentToolDefinition } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  formatWhen,
  withReferences,
  type EntityReference,
  type ReferenceDetail,
} from './references';

/** The conversation services these read tools close over. */
export interface InboxToolDeps {
  presenter: Pick<ConversationPresenter, 'counts'>;
  list: Pick<ConversationListService, 'list'>;
  detail: Pick<ConversationDetailService, 'getDetail' | 'getDetailByKey'>;
}

/** The Inbox tabs, by name. `scheduled` is the "Scheduled" tab. */
const VIEWS = ['to_reply', 'later', 'done', 'scheduled'] as const;

/** Which kinds a query can ask for. `message` is a direct message. */
const TYPES = ['all', 'message', 'comment', 'mention'] as const;

/** How many conversations one answer can name before it stops being useful. */
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

/** How much of a message to keep as a preview. Long enough to recognise it. */
const PREVIEW_CHARS = 140;

/** How many messages of one conversation to replay in a detail answer. */
const MAX_THREAD_MESSAGES = 30;

/** A conversation id is a uuid; anything else is an old thread key. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = {
  error: 'No conversation with that id in this workspace.',
};

/** Collapse whitespace and clip, so a preview stays one readable line. */
function preview(
  text: string | null | undefined,
  limit = PREVIEW_CHARS,
): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > limit
    ? `${oneLine.slice(0, limit).trimEnd()}…`
    : oneLine;
}

/** A person's label: display name, then handle, so it is never blank. */
function chipLabel(who: {
  displayName?: string | null;
  handle?: string;
}): string {
  return who.displayName?.trim() || who.handle?.trim() || 'Unknown sender';
}

/**
 * The one thing the user would do next. Only a conversation in `to_reply` is
 * waiting on them; `later` and `done` are parked or finished.
 */
function suggestedAction(status: ConversationRow['status']): string | null {
  return status === 'to_reply' ? 'send a reply' : null;
}

function snippetText(r: ConversationRow): string {
  if (r.contentRedacted) return '[removed by platform retention policy]';
  return preview(r.snippet.text);
}

/** One row as the model sees it. */
function summarizeRow(r: ConversationRow) {
  const action = suggestedAction(r.status);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    platform: r.platform,
    channel: r.channelLabel,
    snippet: snippetText(r),
    snippetFromMe: r.snippet.fromMe,
    unreadMessages: r.unreadCount,
    assignee: r.assignee?.name ?? null,
    lastMessageAt: r.lastMessageAt,
    replyWindow: {
      state: r.replyWindow.state,
      closesAt: r.replyWindow.closesAt,
    },
    ...(action ? { suggestedAction: action } : {}),
  };
}

/** The facts a hover card shows about a conversation. */
function rowDetails(r: ConversationRow): ReferenceDetail[] {
  const details: ReferenceDetail[] = [];
  const text = snippetText(r);
  if (text) {
    details.push({
      label: r.snippet.fromMe ? 'You said' : 'They said',
      value: text.length > 90 ? `${text.slice(0, 90)}…` : text,
    });
  }
  const when = formatWhen(r.lastMessageAt);
  if (when) details.push({ label: 'Last message', value: when });
  return details;
}

/** One conversation as a chip. `id` is the conversation uuid. */
function referenceFor(r: ConversationRow): EntityReference {
  return {
    kind: 'conversation',
    id: r.id,
    label: r.title || 'Conversation',
    status: r.status,
    platform: r.platform,
    details: rowDetails(r),
  };
}

interface FlatMessage {
  from: string;
  text: string;
  at: string;
  fromMe: boolean;
  depth?: number;
}

/** Flatten a comment tree into reading order, with a depth marker. */
function flattenComments(nodes: CommentNode[], depth = 0): FlatMessage[] {
  const out: FlatMessage[] = [];
  for (const node of nodes) {
    out.push({
      from: chipLabel(node.author),
      text: node.contentRedacted
        ? '[removed by platform retention policy]'
        : preview(node.text, 400),
      at: node.at,
      fromMe: node.fromMe,
      depth,
    });
    if (node.replies?.length) {
      out.push(...flattenComments(node.replies, depth + 1));
    }
  }
  return out;
}

/**
 * The messages of a detail, oldest first. Timeline entries of kind `note`
 * (internal team notes) and `scheduled` (unsent drafts) are skipped.
 */
function messagesOf(d: ConversationDetail): {
  messages: FlatMessage[];
  olderMessagesNotShown: number;
} {
  if (d.comments) {
    const flat = flattenComments(d.comments);
    return {
      messages: flat.slice(0, MAX_THREAD_MESSAGES),
      olderMessagesNotShown: Math.max(0, flat.length - MAX_THREAD_MESSAGES),
    };
  }
  const all: FlatMessage[] = [];
  for (const e of d.timeline) {
    if (e.kind !== 'message') continue;
    all.push({
      from: chipLabel(e.author),
      text:
        preview(e.text, 400) ||
        (e.attachments.length ? `[${e.attachments[0].kind}]` : ''),
      at: e.at,
      fromMe: e.from === 'me',
    });
  }
  const shown = all.slice(-MAX_THREAD_MESSAGES);
  return {
    messages: shown,
    olderMessagesNotShown: all.length - shown.length,
  };
}

/**
 * Read-only tools over the workspace's inbox, on the conversation model.
 *
 * Every count is a CONVERSATION count and every id is a conversation uuid, the
 * same numbers and ids as the Inbox tabs. Every read passes `ctx.workspaceId`
 * and `ctx.userId`, never values from tool arguments, so the tenant boundary
 * is enforced by shape rather than by instruction.
 */
export function createInboxTools(deps: InboxToolDeps): AgentToolDefinition[] {
  return [
    {
      name: 'get_inbox_summary',
      description:
        'Counts of what is sitting in the inbox. Use this for "anything waiting for me?", "how is my inbox looking", or as a cheap first check before deciding whether to list anything. Returns counts only — call list_conversations when the user wants to know WHO is waiting.\n\n' +
        'Every number here is a CONVERSATION count, the same numbers the Inbox tabs show: `toReplyConversations` is the To reply tab, `laterConversations` the Later tab, `scheduledConversations` the Scheduled tab. `answeredToday` is how many conversations were answered today and which teammates answered them. Say "4 conversations need a reply".',
      inputSchema: {},
      handler: async (_args, ctx) => {
        const c = await deps.presenter.counts(ctx.workspaceId);
        return {
          toReplyConversations: c.toReply,
          laterConversations: c.later,
          scheduledConversations: c.scheduled,
          answeredToday: {
            total: c.answeredToday.total,
            by: c.answeredToday.by.map((u) => u.name),
          },
        };
      },
    },

    {
      name: 'list_conversations',
      description:
        'List inbox conversations — direct messages, comments on posts and mentions together, newest first. Use this for "who is waiting on me", "what is parked for later", "what came in on Instagram", or before offering to draft a reply.\n\n' +
        'Pick the Inbox tab with `view`: to_reply (waiting on the user, the default), later (snoozed), done, or scheduled (replies queued to send). Each row is one conversation; `status` is the conversation status (to_reply, later or done).\n\n' +
        'COUNT CONVERSATIONS, NOT PEOPLE. Two rows can be the same person, so "5 conversations" is right and "5 people" is a claim the data does not support. NEVER MERGE IDENTITIES ACROSS PLATFORMS: a Threads handle and a Discord name that look alike are different accounts as far as you know.\n\n' +
        'The chip already shows the name, the platform logo and the status. So your prose beside a chip must carry only what the chip CANNOT: what was said (`snippet`; check `snippetFromMe` — when true it is the USER\'S OWN last message, so say "you replied last"). Mention `replyWindow` only when its state is `closing` or `closed`, because it changes what the user can do. One conversation per line, opening with the chip. Use `suggestedAction` instead of writing your own.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        view: z
          .enum(VIEWS)
          .optional()
          .describe(
            'The Inbox tab: to_reply (default), later, done or scheduled.',
          ),
        type: z
          .enum(TYPES)
          .optional()
          .describe(
            'Restrict to direct messages ("message"), post comments ("comment") or mentions ("mention"). Omit or "all" for every kind.',
          ),
        channelId: z
          .string()
          .optional()
          .describe(
            'Optional channel id to restrict to one connected account. Omit for every channel.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `Max conversations to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
          ),
      },
      handler: async (args, ctx) => {
        const view: InboxView =
          typeof args.view === 'string' &&
          (VIEWS as readonly string[]).includes(args.view)
            ? (args.view as InboxView)
            : 'to_reply';
        const type: InboxType =
          typeof args.type === 'string' &&
          (TYPES as readonly string[]).includes(args.type)
            ? (args.type as InboxType)
            : 'all';
        const channel = Number(
          typeof args.channelId === 'string' ? args.channelId.trim() : NaN,
        );
        const limit = Math.min(
          Math.max(Math.trunc(Number(args.limit)) || DEFAULT_LIMIT, 1),
          MAX_LIMIT,
        );

        const query = {
          view,
          type,
          limit,
          ...(Number.isInteger(channel) && channel > 0
            ? { channelIds: [channel] }
            : {}),
        } as ListConversationsQueryDto;

        const res = await deps.list.list(ctx.workspaceId, ctx.userId, query);
        const page = res.rows.slice(0, limit);

        return withReferences(
          {
            view,
            ...(type !== 'all' ? { filteredByType: type } : {}),
            // `total` is every conversation matching, `showing` the page.
            totalConversations: res.total,
            showing: page.length,
            conversations: page.map(summarizeRow),
          },
          page.map(referenceFor),
        );
      },
    },

    {
      name: 'get_conversation',
      description:
        'Read one conversation in full: the messages or comments in it, who wrote each, and when. Use this after list_conversations narrowed things down, or when the user asks what someone actually said. Needed before drafting any reply — never answer on behalf of the user without reading what they are replying to. Internal team notes are not included.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        conversationId: z
          .string()
          .describe(
            'The conversation id from list_conversations (a uuid). An older thread key like "12:abc" from earlier chat history also works.',
          ),
      },
      handler: async (args, ctx) => {
        const id =
          typeof args.conversationId === 'string'
            ? args.conversationId.trim()
            : '';
        if (!id) {
          return { error: 'A conversation id is required.' };
        }

        let detail: ConversationDetail;
        try {
          // Both lookups are scoped to the caller workspace by the service, so
          // another tenant's conversation fails exactly like one that never
          // existed — deliberately indistinguishable to the model.
          detail = UUID_RE.test(id)
            ? await deps.detail.getDetail(ctx.workspaceId, id, ctx.userId)
            : await deps.detail.getDetailByKey(ctx.workspaceId, id, ctx.userId);
        } catch {
          return NOT_FOUND;
        }

        const { messages, olderMessagesNotShown } = messagesOf(detail);
        const caption = detail.post?.caption;

        return withReferences(
          {
            conversation: summarizeRow(detail.row),
            ...(caption ? { post: { caption: preview(caption, 200) } } : {}),
            ...(detail.mention
              ? { mention: { text: preview(detail.mention.text, 400) } }
              : {}),
            messages,
            ...(olderMessagesNotShown > 0 ? { olderMessagesNotShown } : {}),
          },
          [referenceFor(detail.row)],
        );
      },
    },
  ];
}
