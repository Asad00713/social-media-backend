import { z } from 'zod';
import type {
  InboxService,
  CommentThreadSummary,
  DmConversationSummaryDto,
  CommentNodeDto,
} from '../../inbox/inbox.service';
import type { AgentToolDefinition } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';

/**
 * Statuses an inbox item can carry, straight from INBOX_ITEM_STATUSES.
 *
 * Listed by status rather than by the UI's smart folders on purpose. The
 * folders map only three of these four — `replied` belongs to no folder at all
 * — so filtering by folder would make a replied thread unreachable through the
 * agent exactly as it is through the sidebar. Status is the honest axis.
 */
const INBOX_STATUSES = ['unread', 'needs_reply', 'replied', 'done'] as const;

/** Which conversation kinds a query can ask for. */
const CONVERSATION_TYPES = ['comment', 'dm', 'all'] as const;

/** How many conversations one answer can name before it stops being useful. */
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

/** How much of a message to keep as a preview. Long enough to recognise it. */
const PREVIEW_CHARS = 140;

/** How many messages of one conversation to replay in a detail answer. */
const MAX_THREAD_MESSAGES = 30;

/**
 * Whether this conversation is waiting on the user.
 *
 * `unread` was never opened and `needs_reply` was explicitly flagged — both sit
 * still until someone acts. `replied` and `done` are handled.
 *
 * Computed here rather than left to the model, for the same reason campaigns
 * do it: "what needs a reply" is the question behind almost every inbox
 * question, and re-deriving it from four status strings gets it wrong
 * eventually.
 */
function needsAttention(status: string): boolean {
  return status === 'unread' || status === 'needs_reply';
}

/**
 * The one thing the user would do about this conversation next.
 *
 * The chip already shows the status, so prose has to earn its place by saying
 * what the status MEANS. Supplying the verb keeps that consistent instead of
 * leaving the model to invent a phrasing per row.
 */
function suggestedAction(status: string): string | null {
  switch (status) {
    case 'unread':
      return 'read it and reply';
    case 'needs_reply':
      return 'send a reply';
    default:
      return null;
  }
}

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

/**
 * The chip's text for a conversation.
 *
 * A conversation has no name, so the person is the closest thing to one — it is
 * also how the Inbox list identifies a row. Falls back to the handle, then to a
 * generic label, so a chip is never blank.
 */
function chipLabel(who: { displayName?: string; handle?: string }): string {
  const name = who.displayName?.trim() || who.handle?.trim();
  return name || 'Unknown sender';
}

/**
 * One conversation, normalised across the two shapes the service returns.
 *
 * Comment threads and DM conversations are different DTOs but the same thing to
 * a user: someone said something and it may need an answer. Flattening them
 * here lets one list answer "what's waiting" without the model first having to
 * choose a message type.
 */
interface NormalizedConversation {
  id: string;
  type: 'comment' | 'dm';
  channelId: string;
  platform: string;
  status: string;
  /** Who wrote the most recent incoming message. */
  from: string;
  lastMessage: string;
  /** True when the last message was sent BY the user, not by the other person. */
  lastMessageFromMe?: boolean;
  lastMessageAt: string;
  unreadCount: number;
  totalMessages: number;
  /** Comment threads only: the post being commented on. */
  onPost?: string;
  /** True when the platform's reply window has closed (FB/IG DMs). */
  cannotReply?: string;
}

function fromCommentThread(t: CommentThreadSummary): NormalizedConversation {
  return {
    id: t.id,
    type: 'comment',
    channelId: t.channelId,
    platform: t.platform,
    status: t.status,
    from: chipLabel(t.latestCommenter),
    // A redacted preview is not empty by accident — say so, rather than
    // showing a blank line that reads as a bug.
    lastMessage: t.contentRedacted
      ? '[removed by platform retention policy]'
      : preview(t.lastCommentText),
    lastMessageAt: t.lastCommentAt,
    unreadCount: t.unreadCount,
    totalMessages: t.totalCommentCount,
    ...(t.post?.caption ? { onPost: preview(t.post.caption, 60) } : {}),
  };
}

function fromDmConversation(
  d: DmConversationSummaryDto,
): NormalizedConversation {
  // The reply window is the one fact that changes what the user CAN do, so it
  // travels with the row rather than waiting for a detail call.
  const blocked =
    d.replyWindow && !d.replyWindow.canReply
      ? d.replyWindow.reason || 'the platform reply window has closed'
      : null;

  // A non-text last message shows as its kind: "[image]" beats an empty
  // preview that looks like nothing was said.
  const lastMessage =
    preview(d.lastMessageText) ||
    (d.lastMessageKind !== 'text' ? `[${d.lastMessageKind}]` : '');

  return {
    id: d.id,
    type: 'dm',
    channelId: d.channelId,
    platform: d.platform,
    status: d.status,
    from: chipLabel(d.participant),
    lastMessage,
    // Whose words those are. Without this the preview is ambiguous, and when
    // the last message is OURS it says nothing about why the row is waiting —
    // two conversations then look identical, distinguishable only by a name
    // both of them share.
    lastMessageFromMe: d.lastMessageFromMe,
    lastMessageAt: d.lastMessageAt,
    unreadCount: d.unreadCount,
    totalMessages: d.totalMessageCount,
    ...(blocked ? { cannotReply: blocked } : {}),
  };
}

/** One conversation as a chip: the person's name, its state, its platform logo. */
function referenceFor(c: NormalizedConversation): EntityReference {
  return {
    kind: 'conversation',
    id: c.id,
    label: c.from,
    status: c.status,
    platform: c.platform,
  };
}

/** Everything an answer needs about one conversation, plus what to do about it. */
function summarize(c: NormalizedConversation) {
  return {
    ...c,
    needsAttention: needsAttention(c.status),
    ...(suggestedAction(c.status)
      ? { suggestedAction: suggestedAction(c.status) }
      : {}),
  };
}

/**
 * Flatten a comment tree into reading order.
 *
 * The detail DTO nests replies arbitrarily deep. A model answering "what did
 * they say" needs the conversation in sequence, not its tree structure, so the
 * nesting is flattened to a depth marker.
 */
function flattenComments(
  nodes: CommentNodeDto[],
  depth = 0,
): Array<{
  from: string;
  text: string;
  at: string;
  fromMe: boolean;
  depth: number;
}> {
  const out: Array<{
    from: string;
    text: string;
    at: string;
    fromMe: boolean;
    depth: number;
  }> = [];
  for (const node of nodes) {
    out.push({
      from: chipLabel(node.author),
      text: node.contentRedacted
        ? '[removed by platform retention policy]'
        : preview(node.text, 400),
      at: node.timestamp,
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
 * Read-only tools over the workspace's inbox.
 *
 * Three tools: a count-only summary for "is anything waiting", one list that
 * spans both comments and DMs for "what needs a reply", and a detail tool for
 * "what was actually said". Splitting comments and DMs into separate list tools
 * would make the model choose a message type before it can answer a question
 * that is not about message types.
 *
 * Every read passes `ctx.workspaceId` AND `ctx.userId` to the service, which
 * asserts workspace membership itself — never values taken from tool arguments,
 * so the tenant boundary is enforced by shape rather than by instruction.
 */
export function createInboxTools(inbox: InboxService): AgentToolDefinition[] {
  return [
    {
      name: 'get_inbox_summary',
      description:
        'Counts of what is sitting in the inbox. Use this for "anything waiting for me?", "how is my inbox looking", or as a cheap first check before deciding whether to list anything. Returns counts only — call list_conversations when the user wants to know WHO is waiting.\n\n' +
        'COUNT THE RIGHT THING. Every count here is a count of MESSAGES (individual comments and DMs), not of conversations — `waitingMessages: 19` means 19 comments across a smaller number of threads. Say "19 comments need a reply", never "19 conversations": the Inbox screen groups those same 19 into a handful of threads, so calling them conversations contradicts what the user is looking at. `conversationCount` is the grouped number when you need it.',
      inputSchema: {},
      handler: async (_args, ctx) => {
        // Two reads because they count different things. getCounts returns
        // MESSAGE counts (what the sidebar badges show); the conversation count
        // has to come from the grouped lists. Answering "is anything waiting"
        // with only one of them is how the agent ended up telling the user it
        // had "19 conversations" while the Inbox showed 5.
        const [counts, comments, dms] = await Promise.all([
          inbox.getCounts(ctx.workspaceId, ctx.userId),
          inbox.listCommentThreads(ctx.workspaceId, ctx.userId, {
            limit: MAX_LIMIT,
          }),
          inbox.listDmConversations(ctx.workspaceId, ctx.userId, {
            limit: MAX_LIMIT,
          }),
        ]);

        const f = counts.smartFolders;
        const threads = [
          ...comments.threads.map(fromCommentThread),
          ...dms.threads.map(fromDmConversation),
        ];
        const waitingThreads = threads.filter((t) => needsAttention(t.status));

        return {
          // Named so the unit is impossible to lose: these are messages.
          waitingMessages: f.unread + f.needs_reply,
          unreadMessages: f.unread,
          needsReplyMessages: f.needs_reply,
          doneMessages: f.done,
          totalMessages: f.all,
          // …and these are the threads the Inbox screen actually lists.
          conversationCount: threads.length,
          waitingConversationCount: waitingThreads.length,
          perChannel: counts.perChannel,
        };
      },
    },

    {
      name: 'list_conversations',
      description:
        'List inbox conversations — comments on posts and direct messages together, newest first. Use this for "who is waiting on me", "any unread messages", "what came in on Instagram", or before offering to draft a reply.\n\n' +
        'The result arrives already split into `needsAttention` (unread and needs-reply — the ones waiting on the user) and `handled`. Lead your answer with that split: say how many need attention, name those first, and only then mention the rest. Do not walk through every conversation in list order before reaching the point.\n\n' +
        'COUNT CONVERSATIONS, NOT PEOPLE. Each row is one conversation. Two rows can be the same person, so "5 conversations" is right and "5 people" is a claim the data does not support.\n\n' +
        'NEVER MERGE IDENTITIES ACROSS PLATFORMS. A Threads handle and a Discord display name that look alike are two different accounts as far as you know — this product does not resolve identities across platforms. You may say "3 of these are from the same Threads account" (same platform, same handle: verifiable). You may NOT say "most of these are from the same person" about rows on different platforms.\n\n' +
        'Each conversation carries a `suggestedAction`. Use it instead of writing your own, and never explain what the status means ("it is unread, so nobody has read it"): the chip shows the state, so your words are for what to do about it.\n\n' +
        'The chip already shows the name, the platform logo, and the status. So your prose beside a chip must carry only what the chip CANNOT: the post title a comment is on, or the message itself. Never write the sender name again, never name the platform, never restate the status.\n\n' +
        'Give every row something that tells it apart. Two rows for the same person are indistinguishable unless you add the post title or the message text. `lastMessage` is what to use — but check `lastMessageFromMe` first: when it is true that text is the USER\'S OWN last message, so say so ("you replied last") rather than presenting it as what the other person said. Some DMs carry `cannotReply`, meaning the platform reply window has closed; mention that only when it applies, because it changes what the user can actually do.\n\n' +
        'ONE CONVERSATION PER LINE. Never run several chips together inside one sentence — the reader cannot tell which words belong to which chip, and a shared clause ("all from the same person") is the name repeated for every one of them. Give each its own bullet, opening with the chip and following with only what that chip cannot show.\n\n' +
        'Group by platform when there is more than one, with a PLAIN TEXT header — never a chip. A chip is a promise that clicking it opens that one thing; a chip in a section label looks tappable and goes nowhere useful. Count the header in threads or DMs, never in comments: "comments" is the unit of the 19-style total, and reusing it for a group of 3 threads reads as 3 comments.\n\n' +
        'Like this:\n' +
        '  5 conversations need a reply:\n\n' +
        '  Threads · 3 threads\n' +
        '  - [[ref:10:123]] "Message to test author." — "@asadman289 Hiiii"\n' +
        '  - [[ref:10:456]] "One more post to test Author." — "Hello"\n\n' +
        '  Discord · 2 DMs\n' +
        '  - [[ref:1:789]] "Hi"\n' +
        '  - [[ref:1:790]] "Helo" — you replied last\n\n' +
        'Never like this:\n' +
        '  Threads (3 comments from [[ref:10:123]]):\n' +
        '  - [[ref:10:123]] from asad_codm on your Threads post "Message to test author."\n' +
        '  (A chip used as a section label; "comments" where the unit is threads; the sender and the platform written out though every chip already shows both.)' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        type: z
          .enum(CONVERSATION_TYPES)
          .optional()
          .describe(
            'Restrict to post comments ("comment") or direct messages ("dm"). Omit or "all" for both.',
          ),
        status: z
          .enum(INBOX_STATUSES)
          .optional()
          .describe(
            'Optional status filter. Omit to list conversations in every state.',
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
        const type =
          typeof args.type === 'string' &&
          (CONVERSATION_TYPES as readonly string[]).includes(args.type)
            ? (args.type as (typeof CONVERSATION_TYPES)[number])
            : 'all';
        const status =
          typeof args.status === 'string' &&
          (INBOX_STATUSES as readonly string[]).includes(args.status)
            ? (args.status as (typeof INBOX_STATUSES)[number])
            : undefined;
        const channelId =
          typeof args.channelId === 'string' && args.channelId.trim()
            ? args.channelId.trim()
            : undefined;
        const limit = Math.min(
          Math.max(Number(args.limit) || DEFAULT_LIMIT, 1),
          MAX_LIMIT,
        );

        const options = {
          ...(status ? { status } : {}),
          ...(channelId ? { channelId } : {}),
          // Fetch each side at the full limit: after merging, the newest `limit`
          // may all come from one side, and asking each for `limit/2` would
          // silently drop the rest.
          limit,
        };

        // Both sides are fetched even for a single-type query only when that
        // type asks for it — a `comment` query never pays for the DM scan.
        const [comments, dms] = await Promise.all([
          type === 'dm'
            ? Promise.resolve({ threads: [] as CommentThreadSummary[] })
            : inbox.listCommentThreads(ctx.workspaceId, ctx.userId, options),
          type === 'comment'
            ? Promise.resolve({ threads: [] as DmConversationSummaryDto[] })
            : inbox.listDmConversations(ctx.workspaceId, ctx.userId, options),
        ]);

        const merged: NormalizedConversation[] = [
          ...comments.threads.map(fromCommentThread),
          ...dms.threads.map(fromDmConversation),
        ].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

        const page = merged.slice(0, limit);
        const waiting = page.filter((c) => needsAttention(c.status));
        const handled = page.filter((c) => !needsAttention(c.status));

        return withReferences(
          {
            // `showing` vs `total`: the merged count is what actually matched,
            // so an answer never claims a number the page has not got.
            total: merged.length,
            showing: page.length,
            ...(status ? { filteredByStatus: status } : {}),
            ...(type !== 'all' ? { filteredByType: type } : {}),
            needsAttentionCount: waiting.length,
            handledCount: handled.length,
            needsAttention: waiting.map(summarize),
            handled: handled.map(summarize),
          },
          page.map(referenceFor),
        );
      },
    },

    {
      name: 'get_conversation',
      description:
        'Read one conversation in full: every message or comment in it, who wrote each, and when. Use this after list_conversations narrowed things down, or when the user asks what someone actually said. Needed before drafting any reply — never answer on behalf of the user without reading what they are replying to.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        conversationId: z
          .string()
          .describe(
            'The conversation id from list_conversations (a thread key like "12:abc").',
          ),
        type: z
          .enum(['comment', 'dm'])
          .describe(
            'Whether this id is a comment thread or a DM conversation — list_conversations reports it as `type`.',
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
        const type = args.type === 'dm' ? 'dm' : 'comment';

        try {
          if (type === 'dm') {
            // getDmThread is workspace-scoped and asserts membership, so a
            // conversation in another tenant fails exactly like one that never
            // existed — deliberately indistinguishable to the model.
            const thread = await inbox.getDmThread(
              ctx.workspaceId,
              ctx.userId,
              id,
            );
            const normalized = fromDmConversation(thread);
            const messages = thread.messages.slice(-MAX_THREAD_MESSAGES);

            return withReferences(
              {
                conversation: summarize(normalized),
                // Oldest-first within the tail: a conversation reads forwards.
                messages: messages.map((m) => ({
                  from: chipLabel(m.author),
                  text:
                    preview(m.text, 400) ||
                    (m.attachments?.length ? `[${m.attachments[0].kind}]` : ''),
                  at: m.timestamp,
                  fromMe: m.fromMe,
                })),
                ...(thread.messages.length > messages.length
                  ? {
                      olderMessagesNotShown:
                        thread.messages.length - messages.length,
                    }
                  : {}),
              },
              [referenceFor(normalized)],
            );
          }

          const thread = await inbox.getThread(ctx.workspaceId, ctx.userId, id);
          const normalized = fromCommentThread(thread);
          const flat = flattenComments(thread.rootComments);
          const shown = flat.slice(0, MAX_THREAD_MESSAGES);

          return withReferences(
            {
              conversation: summarize(normalized),
              ...(thread.post?.caption
                ? { post: { caption: preview(thread.post.caption, 200) } }
                : {}),
              comments: shown,
              ...(flat.length > shown.length
                ? { olderMessagesNotShown: flat.length - shown.length }
                : {}),
            },
            [referenceFor(normalized)],
          );
        } catch {
          return { error: 'No conversation with that id in this workspace.' };
        }
      },
    },
  ];
}
