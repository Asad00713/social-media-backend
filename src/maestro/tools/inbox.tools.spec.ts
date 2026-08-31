import type {
  InboxService,
  CommentThreadSummary,
  DmConversationSummaryDto,
  CommentThreadDetail,
  DmThreadDetail,
  InboxCounts,
} from '../../inbox/inbox.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createInboxTools } from './inbox.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

function commentThread(
  over: Partial<CommentThreadSummary> = {},
): CommentThreadSummary {
  return {
    id: '1:post-a',
    type: 'comment',
    channelId: '1',
    platform: 'instagram' as CommentThreadSummary['platform'],
    post: {
      id: 'post-a',
      caption: 'Our autumn collection is live',
      mediaType: 'image',
      publishedAt: '2026-08-20T10:00:00.000Z',
    },
    latestCommenter: {
      handle: 'sara_k',
      displayName: 'Sara Khan',
    },
    status: 'unread',
    lastCommentText: 'Do you ship to Canada?',
    contentRedacted: false,
    lastCommentAt: '2026-08-27T10:00:00.000Z',
    unreadCount: 1,
    totalCommentCount: 3,
    ...over,
  };
}

function dmConversation(
  over: Partial<DmConversationSummaryDto> = {},
): DmConversationSummaryDto {
  return {
    id: '2:conv-b',
    type: 'dm',
    channelId: '2',
    platform: 'facebook' as DmConversationSummaryDto['platform'],
    conversationId: 'conv-b',
    participant: {
      platformId: 'p-9',
      handle: 'omar.h',
      displayName: 'Omar Hassan',
    },
    lastMessageText: 'Is the discount still valid?',
    lastMessageKind: 'text',
    lastMessageAt: '2026-08-27T12:00:00.000Z',
    lastMessageFromMe: false,
    status: 'needs_reply',
    unreadCount: 0,
    totalMessageCount: 5,
    ...over,
  };
}

interface Recorded {
  method: string;
  workspaceId: string;
  userId: string;
  options?: unknown;
  threadKey?: string;
}

/**
 * A stand-in for InboxService that records how it was called.
 *
 * Deliberately filters by workspace itself, the way the real service does, so a
 * tool that leaked a caller-supplied workspace id would return the wrong rows
 * rather than silently passing.
 */
function fakeInbox(
  data: {
    comments?: CommentThreadSummary[];
    dms?: DmConversationSummaryDto[];
    counts?: InboxCounts;
    commentDetail?: CommentThreadDetail;
    dmDetail?: DmThreadDetail;
  },
  calls: Recorded[] = [],
) {
  const guard = (workspaceId: string, userId: string) => {
    if (workspaceId !== CTX.workspaceId || userId !== CTX.userId) {
      throw new Error('Forbidden');
    }
  };

  return {
    listCommentThreads: (
      workspaceId: string,
      userId: string,
      options: Record<string, unknown>,
    ) => {
      calls.push({
        method: 'listCommentThreads',
        workspaceId,
        userId,
        options,
      });
      guard(workspaceId, userId);
      let out = data.comments ?? [];
      if (options.status) out = out.filter((t) => t.status === options.status);
      if (options.channelId)
        out = out.filter((t) => t.channelId === options.channelId);
      return Promise.resolve({ threads: out, nextCursor: null });
    },
    listDmConversations: (
      workspaceId: string,
      userId: string,
      options: Record<string, unknown>,
    ) => {
      calls.push({
        method: 'listDmConversations',
        workspaceId,
        userId,
        options,
      });
      guard(workspaceId, userId);
      let out = data.dms ?? [];
      if (options.status) out = out.filter((d) => d.status === options.status);
      if (options.channelId)
        out = out.filter((d) => d.channelId === options.channelId);
      return Promise.resolve({ threads: out, nextCursor: null });
    },
    getCounts: (workspaceId: string, userId: string) => {
      calls.push({ method: 'getCounts', workspaceId, userId });
      guard(workspaceId, userId);
      return Promise.resolve(
        data.counts ?? {
          perChannel: [],
          smartFolders: { all: 0, unread: 0, needs_reply: 0, done: 0 },
          total: 0,
        },
      );
    },
    getThread: (workspaceId: string, userId: string, threadKey: string) => {
      calls.push({ method: 'getThread', workspaceId, userId, threadKey });
      guard(workspaceId, userId);
      if (!data.commentDetail || data.commentDetail.id !== threadKey) {
        return Promise.reject(new Error('Not found'));
      }
      return Promise.resolve(data.commentDetail);
    },
    getDmThread: (workspaceId: string, userId: string, threadKey: string) => {
      calls.push({ method: 'getDmThread', workspaceId, userId, threadKey });
      guard(workspaceId, userId);
      if (!data.dmDetail || data.dmDetail.id !== threadKey) {
        return Promise.reject(new Error('Not found'));
      }
      return Promise.resolve(data.dmDetail);
    },
  } as unknown as InboxService;
}

function toolNamed(tools: AgentToolDefinition[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
}

/** Unwrap a reference payload, failing loudly if the tool did not produce one. */
function payload(result: unknown): ReferencePayload {
  if (!isReferencePayload(result)) {
    throw new Error(
      `Expected a reference payload, got ${JSON.stringify(result)}`,
    );
  }
  return result;
}

/**
 * One conversation as list_conversations reports it.
 *
 * Declared rather than reached for via `any` so the assertions below are
 * type-checked: a renamed field fails to compile instead of quietly asserting
 * `undefined === undefined`.
 */
interface ListedConversation {
  id: string;
  type: 'comment' | 'dm';
  status: string;
  lastMessage: string;
  lastMessageFromMe?: boolean;
  lastMessageAt: string;
  suggestedAction?: string;
  cannotReply?: string;
}

interface ListData {
  total: number;
  showing: number;
  needsAttentionCount: number;
  handledCount: number;
  needsAttention: ListedConversation[];
  handled: ListedConversation[];
  filteredByStatus?: string;
  filteredByType?: string;
}

interface DetailData {
  conversation: ListedConversation;
  comments?: Array<{ from: string; depth: number; fromMe: boolean }>;
  messages?: Array<{ from: string; text: string }>;
}

function dataOf<T>(result: unknown): T {
  return payload(result).data as T;
}

/** Both groups together — most assertions care about the row, not its group. */
function allRows(data: ListData): ListedConversation[] {
  return [...data.needsAttention, ...data.handled];
}

describe('list_conversations', () => {
  it('merges comments and DMs into one list', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [commentThread()],
        dms: [dmConversation()],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(data.total).toBe(2);
    expect(
      allRows(data)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['1:post-a', '2:conv-b']);
  });

  // Sorting is only observable through what the limit KEEPS: the two lists are
  // split by status afterwards, so asserting their order proves nothing. Two
  // comments and one newer DM, limited to 2, must keep the DM — which happens
  // only if the merged list was ordered before it was trimmed.
  it('keeps the newest across both sources when trimming to the limit', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({
            id: '1:old',
            lastCommentAt: '2026-08-01T00:00:00.000Z',
          }),
          commentThread({
            id: '1:older',
            lastCommentAt: '2026-07-01T00:00:00.000Z',
          }),
        ],
        dms: [
          dmConversation({
            id: '2:new',
            lastMessageAt: '2026-08-27T00:00:00.000Z',
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({ limit: 2 }, CTX),
    );

    const kept = allRows(data).map((c) => c.id);
    expect(kept).toContain('2:new');
    expect(kept).not.toContain('1:older');
  });

  it('splits what needs a reply from what is handled', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({ id: '1:a', status: 'unread' }),
          commentThread({ id: '1:b', status: 'done' }),
          commentThread({ id: '1:c', status: 'replied' }),
        ],
        dms: [dmConversation({ id: '2:d', status: 'needs_reply' })],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(data.needsAttentionCount).toBe(2);
    expect(data.handledCount).toBe(2);
    expect(data.needsAttention.map((c: { id: string }) => c.id).sort()).toEqual(
      ['1:a', '2:d'],
    );
  });

  it('carries a suggested action for the ones that are waiting', async () => {
    const tools = createInboxTools(
      fakeInbox({ comments: [commentThread({ status: 'unread' })] }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(data.needsAttention[0].suggestedAction).toBe('read it and reply');
  });

  it('gives no suggested action to a handled conversation', async () => {
    const tools = createInboxTools(
      fakeInbox({ comments: [commentThread({ status: 'done' })] }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(data.handled[0].suggestedAction).toBeUndefined();
  });

  // `replied` maps to no smart folder in the sidebar. Filtering by status
  // rather than folder is what keeps it reachable through the agent.
  it('can still find a replied conversation, which no smart folder holds', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({ id: '1:a', status: 'replied' }),
          commentThread({ id: '1:b', status: 'done' }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler(
        { status: 'replied' },
        CTX,
      ),
    );

    expect(data.showing).toBe(1);
    expect(data.handled[0].id).toBe('1:a');
  });

  it('skips the DM query entirely when asked only for comments', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(
      fakeInbox(
        { comments: [commentThread()], dms: [dmConversation()] },
        calls,
      ),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler(
        { type: 'comment' },
        CTX,
      ),
    );

    expect(calls.some((c) => c.method === 'listDmConversations')).toBe(false);
    expect(data.showing).toBe(1);
    expect(data.filteredByType).toBe('comment');
  });

  it('skips the comment query when asked only for DMs', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(
      fakeInbox(
        { comments: [commentThread()], dms: [dmConversation()] },
        calls,
      ),
    );

    await toolNamed(tools, 'list_conversations').handler({ type: 'dm' }, CTX);

    expect(calls.some((c) => c.method === 'listCommentThreads')).toBe(false);
  });

  it('emits one clickable reference per conversation', async () => {
    const tools = createInboxTools(
      fakeInbox({ comments: [commentThread()], dms: [dmConversation()] }),
    );

    const refs = payload(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    ).refs;

    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({
      kind: 'conversation',
      id: '1:post-a',
      label: 'Sara Khan',
      status: 'unread',
      platform: 'instagram',
    });
  });

  // The chip shows a person, and a row whose sender has no display name would
  // otherwise render as an empty link.
  it('falls back to the handle when a sender has no display name', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({
            latestCommenter: { handle: 'sara_k', displayName: '' },
          }),
        ],
      }),
    );

    const refs = payload(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    ).refs;

    expect(refs[0].label).toBe('sara_k');
  });

  it('never leaves a chip label blank', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({
            latestCommenter: { handle: '', displayName: '   ' },
          }),
        ],
      }),
    );

    const refs = payload(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    ).refs;

    expect(refs[0].label).toBe('Unknown sender');
  });

  it('clamps the limit to the maximum', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(fakeInbox({}, calls));

    await toolNamed(tools, 'list_conversations').handler({ limit: 999 }, CTX);

    const options = calls[0].options as { limit: number };
    expect(options.limit).toBe(50);
  });

  it('trims the merged list to the limit', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({ id: '1:a' }),
          commentThread({ id: '1:b' }),
          commentThread({ id: '1:c' }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({ limit: 2 }, CTX),
    );

    expect(data.showing).toBe(2);
    expect(data.total).toBe(3);
  });

  // A blank preview reads as "nothing was said", which is wrong for a photo.
  it('describes a non-text message by its kind instead of showing nothing', async () => {
    const tools = createInboxTools(
      fakeInbox({
        dms: [
          dmConversation({ lastMessageText: '', lastMessageKind: 'image' }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(allRows(data)[0].lastMessage).toBe('[image]');
  });

  it('says when content was wiped by a retention policy', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({ lastCommentText: '', contentRedacted: true }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(allRows(data)[0].lastMessage).toBe(
      '[removed by platform retention policy]',
    );
  });

  /**
   * Two DM rows for the same person are indistinguishable unless the answer
   * can say something about each. The preview is that something — but only if
   * the agent knows WHOSE words it is quoting. Both of these conversations end
   * with the user's own outbound message, so presenting that text as what the
   * other person said would be wrong twice over.
   */
  it('says whose words the preview is', async () => {
    const tools = createInboxTools(
      fakeInbox({
        dms: [
          dmConversation({
            id: '2:mine',
            lastMessageText: 'New maestro message',
            lastMessageFromMe: true,
          }),
          dmConversation({
            id: '2:theirs',
            lastMessageText: 'Is the discount still valid?',
            lastMessageFromMe: false,
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    const rows = allRows(data);
    expect(rows.find((r) => r.id === '2:mine')?.lastMessageFromMe).toBe(true);
    expect(rows.find((r) => r.id === '2:theirs')?.lastMessageFromMe).toBe(
      false,
    );
  });

  // Whether the user CAN reply changes what the agent should offer to do.
  it('surfaces a closed reply window', async () => {
    const tools = createInboxTools(
      fakeInbox({
        dms: [
          dmConversation({
            replyWindow: { canReply: false, reason: '24-hour window expired' },
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(allRows(data)[0].cannotReply).toBe('24-hour window expired');
  });

  it('says nothing about the reply window when replying is allowed', async () => {
    const tools = createInboxTools(
      fakeInbox({ dms: [dmConversation({ replyWindow: { canReply: true } })] }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_conversations').handler({}, CTX),
    );

    expect(allRows(data)[0].cannotReply).toBeUndefined();
  });

  // The tenant boundary: the workspace comes from ctx, never from arguments.
  it('reads the caller workspace, ignoring any workspaceId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(fakeInbox({}, calls));

    await toolNamed(tools, 'list_conversations').handler(
      { workspaceId: 'ws-someone-else' },
      CTX,
    );

    expect(calls.every((c) => c.workspaceId === 'ws-1')).toBe(true);
  });

  it('passes the caller userId, ignoring any userId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(fakeInbox({}, calls));

    await toolNamed(tools, 'list_conversations').handler(
      { userId: 'u-someone-else' },
      CTX,
    );

    expect(calls.every((c) => c.userId === 'u1')).toBe(true);
  });
});

describe('get_inbox_summary', () => {
  it('names the count that needs a person, not just raw folders', async () => {
    const tools = createInboxTools(
      fakeInbox({
        counts: {
          perChannel: [{ channelId: 1, comments: 2, dms: 1 }],
          smartFolders: { all: 12, unread: 3, needs_reply: 2, done: 7 },
          total: 3,
        },
      }),
    );

    const result = (await toolNamed(tools, 'get_inbox_summary').handler(
      {},
      CTX,
    )) as Record<string, unknown>;

    expect(result.waitingMessages).toBe(5);
    expect(result.unreadMessages).toBe(3);
    expect(result.needsReplyMessages).toBe(2);
    expect(result.totalMessages).toBe(12);
  });

  /**
   * The bug this locks down: getCounts counts individual comments and DMs,
   * but the Inbox screen groups them into threads. Reporting the message
   * count as a conversation count made the agent claim "19 conversations"
   * while the user was looking at a list of 5 — the assistant contradicting
   * the product. Both numbers now ship, each named for what it counts.
   */
  it('separates the message count from the conversation count', async () => {
    const tools = createInboxTools(
      fakeInbox({
        counts: {
          perChannel: [],
          // 19 messages…
          smartFolders: { all: 19, unread: 0, needs_reply: 19, done: 0 },
          total: 19,
        },
        // …grouped into 3 comment threads + 2 DM conversations.
        comments: [
          commentThread({ id: '1:a' }),
          commentThread({ id: '1:b' }),
          commentThread({ id: '1:c' }),
        ],
        dms: [dmConversation({ id: '2:d' }), dmConversation({ id: '2:e' })],
      }),
    );

    const result = (await toolNamed(tools, 'get_inbox_summary').handler(
      {},
      CTX,
    )) as Record<string, unknown>;

    expect(result.needsReplyMessages).toBe(19);
    expect(result.conversationCount).toBe(5);
    expect(result.waitingConversationCount).toBe(5);
  });

  it('counts only the conversations that are actually waiting', async () => {
    const tools = createInboxTools(
      fakeInbox({
        comments: [
          commentThread({ id: '1:a', status: 'unread' }),
          commentThread({ id: '1:b', status: 'done' }),
        ],
        dms: [dmConversation({ id: '2:c', status: 'replied' })],
      }),
    );

    const result = (await toolNamed(tools, 'get_inbox_summary').handler(
      {},
      CTX,
    )) as Record<string, unknown>;

    expect(result.conversationCount).toBe(3);
    expect(result.waitingConversationCount).toBe(1);
  });

  it('reads the caller workspace, ignoring any workspaceId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(fakeInbox({}, calls));

    await toolNamed(tools, 'get_inbox_summary').handler(
      { workspaceId: 'ws-someone-else' },
      CTX,
    );

    expect(calls[0].workspaceId).toBe('ws-1');
  });
});

describe('get_conversation', () => {
  const commentDetail: CommentThreadDetail = {
    ...commentThread(),
    rootComments: [
      {
        id: 'c1',
        parentId: null,
        author: { handle: 'sara_k', displayName: 'Sara Khan' },
        text: 'Do you ship to Canada?',
        contentRedacted: false,
        timestamp: '2026-08-27T10:00:00.000Z',
        fromMe: false,
        platformItemId: 'pi-1',
        status: 'unread',
        likeCount: 0,
        isHidden: false,
        replies: [
          {
            id: 'c2',
            parentId: 'c1',
            author: { handle: 'brand', displayName: 'Our Brand' },
            text: 'Yes we do!',
            contentRedacted: false,
            timestamp: '2026-08-27T10:05:00.000Z',
            fromMe: true,
            platformItemId: 'pi-2',
            status: 'replied',
            likeCount: 0,
            isHidden: false,
            replies: [],
          },
        ],
      },
    ],
  };

  it('flattens a nested comment tree into reading order', async () => {
    const tools = createInboxTools(fakeInbox({ commentDetail }));

    const data = dataOf<DetailData>(
      await toolNamed(tools, 'get_conversation').handler(
        { conversationId: '1:post-a', type: 'comment' },
        CTX,
      ),
    );

    expect(data.comments.map((c: { from: string }) => c.from)).toEqual([
      'Sara Khan',
      'Our Brand',
    ]);
    expect(data.comments[1].depth).toBe(1);
    expect(data.comments[1].fromMe).toBe(true);
  });

  it('returns the whole DM conversation with the newest messages', async () => {
    const dmDetail: DmThreadDetail = {
      ...dmConversation(),
      messages: [
        {
          id: 'm1',
          author: { handle: 'omar.h', displayName: 'Omar Hassan' },
          text: 'Is the discount still valid?',
          timestamp: '2026-08-27T12:00:00.000Z',
          fromMe: false,
          platformItemId: 'pi-1',
          status: 'needs_reply',
        },
      ],
    };
    const tools = createInboxTools(fakeInbox({ dmDetail }));

    const data = dataOf<DetailData>(
      await toolNamed(tools, 'get_conversation').handler(
        { conversationId: '2:conv-b', type: 'dm' },
        CTX,
      ),
    );

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].from).toBe('Omar Hassan');
    expect(data.conversation.status).toBe('needs_reply');
  });

  it('requires a conversation id', async () => {
    const tools = createInboxTools(fakeInbox({}));

    const result = (await toolNamed(tools, 'get_conversation').handler(
      { conversationId: '   ', type: 'comment' },
      CTX,
    )) as { error?: string };

    expect(result.error).toBe('A conversation id is required.');
  });

  it('reports an unknown conversation without leaking why', async () => {
    const tools = createInboxTools(fakeInbox({ commentDetail }));

    const result = (await toolNamed(tools, 'get_conversation').handler(
      { conversationId: '1:nope', type: 'comment' },
      CTX,
    )) as { error?: string };

    expect(result.error).toBe(
      'No conversation with that id in this workspace.',
    );
  });

  // A conversation in another workspace must be indistinguishable from one that
  // never existed — the service throws, and the tool must not say more.
  it('cannot read a conversation from another workspace', async () => {
    const tools = createInboxTools(fakeInbox({ commentDetail }));

    const result = (await toolNamed(tools, 'get_conversation').handler(
      { conversationId: '1:post-a', type: 'comment' },
      { userId: 'u1', workspaceId: 'ws-other' },
    )) as { error?: string };

    expect(result.error).toBe(
      'No conversation with that id in this workspace.',
    );
  });

  it('reads the caller workspace, ignoring any workspaceId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createInboxTools(fakeInbox({ commentDetail }, calls));

    await toolNamed(tools, 'get_conversation').handler(
      {
        conversationId: '1:post-a',
        type: 'comment',
        workspaceId: 'ws-someone-else',
      },
      CTX,
    );

    expect(calls[0].workspaceId).toBe('ws-1');
  });
});
