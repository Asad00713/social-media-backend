import { NotFoundException } from '@nestjs/common';
import type {
  ConversationDetail,
  ConversationRow,
  InboxCounts,
} from '../../inbox/conversations/dto/contract';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createInboxTools } from './inbox.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: UUID_A,
    kind: 'dm',
    threadKey: '2:conv-b',
    channelId: 2,
    channelLabel: 'Shop FB',
    platform: 'facebook',
    status: 'to_reply',
    title: 'Omar Hassan',
    avatarUrl: null,
    thumbnailUrl: null,
    snippet: {
      authorLabel: 'Omar Hassan',
      text: 'Is the discount still valid?',
      fromMe: false,
    },
    unreadCount: 1,
    lastMessageAt: '2026-08-27T12:00:00.000Z',
    assignee: { id: 'u9', name: 'Dana Lee', avatarUrl: null },
    assignedBy: null,
    assignedAt: null,
    laterUntil: null,
    laterUntilReply: false,
    doneBy: null,
    doneAt: null,
    doneVia: null,
    replyWindow: { closesAt: null, state: 'open' },
    scheduled: null,
    contentRedacted: false,
    ...over,
  };
}

function detail(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    row: row(),
    participant: null,
    post: null,
    mention: null,
    comments: null,
    timeline: [],
    latestSendLaterAt: null,
    canSendLater: true,
    ...over,
  };
}

const author = {
  handle: 'omar.h',
  displayName: 'Omar Hassan',
  avatarUrl: null,
};

interface Call {
  method: string;
  args: unknown[];
}

/**
 * Stand-ins for the three conversation services that record how they were
 * called. Like the real ones they refuse another workspace's data, so a tool
 * that leaked a caller-supplied workspace would get nothing back.
 */
function fakes(
  data: {
    counts?: InboxCounts;
    rows?: ConversationRow[];
    detail?: ConversationDetail;
    legacy?: Record<string, string>; // threadKey -> uuid
    fail?: Error; // thrown by the detail service, as an outage would
  } = {},
  calls: Call[] = [],
) {
  const guard = (ws: string) => {
    if (ws !== CTX.workspaceId) throw new NotFoundException('Not found');
  };
  return {
    presenter: {
      counts: (ws: string) => {
        calls.push({ method: 'counts', args: [ws] });
        guard(ws);
        return Promise.resolve(
          data.counts ?? {
            toReply: 4,
            later: 2,
            scheduled: 1,
            answeredToday: {
              total: 7,
              by: [
                { id: 'u9', name: 'Dana Lee', avatarUrl: null },
                { id: 'u8', name: 'Sam Ortiz', avatarUrl: null },
              ],
            },
          },
        );
      },
    },
    list: {
      list: (ws: string, userId: string, q: Record<string, unknown>) => {
        calls.push({ method: 'list', args: [ws, userId, q] });
        guard(ws);
        const rows = data.rows ?? [];
        return Promise.resolve({
          rows,
          nextCursor: null,
          total: rows.length,
        });
      },
    },
    detail: {
      getDetail: (ws: string, id: string, viewer: string) => {
        calls.push({ method: 'getDetail', args: [ws, id, viewer] });
        if (data.fail) throw data.fail;
        guard(ws);
        if (id !== UUID_A || !data.detail) {
          throw new NotFoundException('Conversation not found');
        }
        return Promise.resolve(data.detail);
      },
      getDetailByKey: (ws: string, key: string, viewer: string) => {
        calls.push({ method: 'getDetailByKey', args: [ws, key, viewer] });
        guard(ws);
        const id = data.legacy?.[key];
        if (!id) throw new NotFoundException('Conversation not found');
        return Promise.resolve(data.detail);
      },
    },
  };
}

function tool(
  name: string,
  data: Parameters<typeof fakes>[0] = {},
  calls: Call[] = [],
): AgentToolDefinition {
  const f = fakes(data, calls);
  const found = createInboxTools({
    presenter: f.presenter as never,
    list: f.list as never,
    detail: f.detail as never,
  }).find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** The tool's own data, unwrapped from its reference envelope. */
const unwrap = (result: unknown): unknown => {
  expect(isReferencePayload(result)).toBe(true);
  return (result as ReferencePayload).data;
};

const refsOf = (result: unknown): ReferencePayload['refs'] => {
  expect(isReferencePayload(result)).toBe(true);
  return (result as ReferencePayload).refs;
};

describe('get_inbox_summary', () => {
  it('reports every number as a conversation count under a unit-named field', async () => {
    const out = (await tool('get_inbox_summary').handler({}, CTX)) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({
      toReplyConversations: 4,
      laterConversations: 2,
      scheduledConversations: 1,
      answeredToday: { total: 7, by: ['Dana Lee', 'Sam Ortiz'] },
    });
  });

  it('says in its description that the numbers are conversation counts', () => {
    expect(tool('get_inbox_summary').description).toMatch(/CONVERSATION/);
  });

  it('reads the caller workspace, ignoring a hostile workspaceId argument', async () => {
    const calls: Call[] = [];
    await tool('get_inbox_summary', {}, calls).handler(
      { workspaceId: FOREIGN },
      CTX,
    );
    expect(calls[0].args[0]).toBe(CTX.workspaceId);
  });
});

describe('list_conversations', () => {
  it('refuses a channelId that is not a number rather than widening to every channel', async () => {
    const calls: Call[] = [];
    const out = await tool('list_conversations', {}, calls).handler(
      { channelId: 'abc' },
      CTX,
    );
    expect(out).toEqual({
      error: expect.stringContaining('channelId') as unknown,
    });
    expect(calls).toHaveLength(0);
  });
  it('defaults to the to_reply view, all types, limit 15', async () => {
    const calls: Call[] = [];
    await tool('list_conversations', { rows: [row()] }, calls).handler({}, CTX);
    expect(calls[0].args).toEqual([
      'ws-1',
      'u1',
      expect.objectContaining({ view: 'to_reply', type: 'all', limit: 15 }),
    ]);
  });

  it('passes view, type, channel and limit through', async () => {
    const calls: Call[] = [];
    await tool('list_conversations', {}, calls).handler(
      { view: 'later', type: 'comment', channelId: '7', limit: 5 },
      CTX,
    );
    expect(calls[0].args[2]).toEqual(
      expect.objectContaining({
        view: 'later',
        type: 'comment',
        channelIds: [7],
        limit: 5,
      }),
    );
  });

  it('clamps the limit to 1..50 and falls back on invalid enums', async () => {
    const calls: Call[] = [];
    const t = tool('list_conversations', {}, calls);
    await t.handler({ limit: 500, view: 'bogus', type: 'dm' }, CTX);
    await t.handler({ limit: -3 }, CTX);
    expect(calls[0].args[2]).toEqual(
      expect.objectContaining({ limit: 50, view: 'to_reply', type: 'all' }),
    );
    expect(calls[1].args[2]).toEqual(expect.objectContaining({ limit: 1 }));
  });

  it('returns conversation uuids, statuses, assignee name and reply window', async () => {
    const out = unwrap(
      await tool('list_conversations', {
        rows: [
          row(),
          row({
            id: UUID_B,
            status: 'later',
            assignee: null,
            replyWindow: { closesAt: '2026-08-28T00:00:00Z', state: 'closing' },
          }),
        ],
      }).handler({}, CTX),
    ) as {
      conversations: Array<Record<string, unknown>>;
    };
    expect(out.conversations[0]).toEqual(
      expect.objectContaining({
        id: UUID_A,
        kind: 'dm',
        status: 'to_reply',
        title: 'Omar Hassan',
        snippet: 'Is the discount still valid?',
        assignee: 'Dana Lee',
        lastMessageAt: '2026-08-27T12:00:00.000Z',
        replyWindow: expect.objectContaining({ state: 'open' }) as unknown,
      }),
    );
    expect(out.conversations[1]).toEqual(
      expect.objectContaining({ id: UUID_B, assignee: null }),
    );
  });

  it('emits references keyed by the uuid with the conversation status', async () => {
    const refs = refsOf(
      await tool('list_conversations', {
        rows: [row(), row({ id: UUID_B, status: 'done' })],
      }).handler({}, CTX),
    );
    expect(refs.map((r) => [r.kind, r.id, r.status])).toEqual([
      ['conversation', UUID_A, 'to_reply'],
      ['conversation', UUID_B, 'done'],
    ]);
  });

  it('reads the caller workspace and user, ignoring hostile arguments', async () => {
    const calls: Call[] = [];
    await tool('list_conversations', {}, calls).handler(
      { workspaceId: FOREIGN, userId: 'attacker' },
      CTX,
    );
    expect(calls[0].args.slice(0, 2)).toEqual(['ws-1', 'u1']);
  });
});

describe('get_conversation', () => {
  const dmDetail = detail({
    timeline: [
      {
        kind: 'message',
        id: 'm1',
        from: 'them',
        author,
        text: 'Hello',
        at: '2026-08-27T10:00:00Z',
        attachments: [],
        sentBy: null,
        canDelete: false,
      },
      {
        kind: 'note',
        id: 'n1',
        author: { id: 'u9', name: 'Dana Lee', avatarUrl: null },
        body: 'INTERNAL SECRET',
        mentions: [],
        at: '2026-08-27T10:30:00Z',
        canDelete: true,
      },
      {
        kind: 'message',
        id: 'm2',
        from: 'me',
        author: { handle: 'shop', displayName: 'Shop', avatarUrl: null },
        text: 'Hi Omar',
        at: '2026-08-27T11:00:00Z',
        attachments: [],
        sentBy: null,
        canDelete: true,
      },
    ],
  });

  it('reads a uuid through getDetail with the caller tenant', async () => {
    const calls: Call[] = [];
    const out = unwrap(
      await tool('get_conversation', { detail: dmDetail }, calls).handler(
        { conversationId: UUID_A },
        CTX,
      ),
    ) as {
      messages: Array<{ text: string; fromMe: boolean }>;
    };
    expect(calls[0]).toEqual({
      method: 'getDetail',
      args: ['ws-1', UUID_A, 'u1'],
    });
    expect(out.messages.map((m) => [m.text, m.fromMe])).toEqual([
      ['Hello', false],
      ['Hi Omar', true],
    ]);
  });

  it('never returns internal notes', async () => {
    const out = await tool('get_conversation', { detail: dmDetail }).handler(
      { conversationId: UUID_A },
      CTX,
    );
    expect(JSON.stringify(out)).not.toContain('INTERNAL SECRET');
  });

  it('resolves a legacy thread key to the uuid before reading', async () => {
    const calls: Call[] = [];
    const out = await tool(
      'get_conversation',
      { detail: dmDetail, legacy: { '12:abc': UUID_A } },
      calls,
    ).handler({ conversationId: '12:abc' }, CTX);
    expect(calls[0]).toEqual({
      method: 'getDetailByKey',
      args: ['ws-1', '12:abc', 'u1'],
    });
    expect(refsOf(out)[0].id).toBe(UUID_A);
  });

  it('keeps at most the 30 newest messages, oldest first', async () => {
    const many = detail({
      timeline: Array.from({ length: 40 }, (_, i) => ({
        kind: 'message' as const,
        id: `m${i}`,
        from: 'them' as const,
        author,
        text: `msg ${i}`,
        at: '2026-08-27T10:00:00Z',
        attachments: [],
        sentBy: null,
        canDelete: false,
      })),
    });
    const out = unwrap(
      await tool('get_conversation', { detail: many }).handler(
        { conversationId: UUID_A },
        CTX,
      ),
    ) as { messages: Array<{ text: string }>; olderMessagesNotShown: number };
    expect(out.messages).toHaveLength(30);
    expect(out.messages[0].text).toBe('msg 10');
    expect(out.messages[29].text).toBe('msg 39');
    expect(out.olderMessagesNotShown).toBe(10);
  });

  it('flattens a comment tree and returns the post caption', async () => {
    const node = (id: string, text: string, replies: never[] = []) =>
      ({
        id,
        parentId: null,
        author,
        text,
        at: '2026-08-27T10:00:00Z',
        fromMe: false,
        replies,
        contentRedacted: false,
      }) as never;
    const d = detail({
      row: row({ kind: 'comment_thread' }),
      post: { caption: 'Autumn drop' } as never,
      comments: [node('c1', 'root', [node('c2', 'child')] as never[])],
    });
    const out = unwrap(
      await tool('get_conversation', { detail: d }).handler(
        { conversationId: UUID_A },
        CTX,
      ),
    ) as { messages: Array<{ text: string; depth: number }>; post: unknown };
    expect(out.messages.map((m) => [m.text, m.depth])).toEqual([
      ['root', 0],
      ['child', 1],
    ]);
    expect(out.post).toEqual({ caption: 'Autumn drop' });
  });

  it('requires a conversation id', async () => {
    const out = await tool('get_conversation').handler({}, CTX);
    expect(out).toEqual({ error: 'A conversation id is required.' });
  });

  it('reports another workspace or unknown id without saying which', async () => {
    const miss = { error: 'No conversation with that id in this workspace.' };
    expect(
      await tool('get_conversation', { detail: dmDetail }).handler(
        { conversationId: FOREIGN },
        CTX,
      ),
    ).toEqual(miss);
    expect(
      await tool('get_conversation', { detail: dmDetail }).handler(
        { conversationId: 'nope:key' },
        CTX,
      ),
    ).toEqual(miss);
  });

  it('a caller in another workspace cannot read a known conversation', async () => {
    // The id exists in ws-1; only the guard on the caller workspace refuses it.
    const out = await tool('get_conversation', { detail: dmDetail }).handler(
      { conversationId: UUID_A },
      { userId: 'u1', workspaceId: 'ws-other' },
    );
    expect(out).toEqual({
      error: 'No conversation with that id in this workspace.',
    });
  });

  it('does not disguise an infrastructure failure as a missing conversation', async () => {
    await expect(
      tool('get_conversation', {
        detail: dmDetail,
        fail: new Error('db down'),
      }).handler({ conversationId: UUID_A }, CTX),
    ).rejects.toThrow('db down');
  });

  it('names the cut correctly when a comment tree is over the cap', async () => {
    const node = (i: number) =>
      ({
        id: `c${i}`,
        parentId: null,
        author,
        text: `c ${i}`,
        at: '2026-08-27T10:00:00Z',
        fromMe: false,
        replies: [],
        contentRedacted: false,
      }) as never;
    const d = detail({
      row: row({ kind: 'comment_thread' }),
      comments: Array.from({ length: 35 }, (_, i) => node(i)),
    });
    const out = unwrap(
      await tool('get_conversation', { detail: d }).handler(
        { conversationId: UUID_A },
        CTX,
      ),
    ) as Record<string, unknown>;
    // The FIRST 30 are kept, so what is dropped is the newest, not the oldest.
    expect(out.newerMessagesNotShown).toBe(5);
    expect(out.olderMessagesNotShown).toBeUndefined();
  });

  it('reads the caller workspace, ignoring a hostile workspaceId argument', async () => {
    const calls: Call[] = [];
    await tool('get_conversation', { detail: dmDetail }, calls).handler(
      { conversationId: UUID_A, workspaceId: FOREIGN, userId: 'attacker' },
      CTX,
    );
    expect(calls[0].args[0]).toBe('ws-1');
    expect(calls[0].args[2]).toBe('u1');
  });
});
