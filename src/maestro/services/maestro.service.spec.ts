import { NotFoundException } from '@nestjs/common';
import {
  roleCan,
  type Capability,
  type WorkspaceRole,
} from '../../workspace-members/role-capabilities';
import { MaestroService } from './maestro.service';
import type { AgentEvent } from '../maestro.types';

/**
 * The whole frontend activity row is built on the order and shape of the
 * events `streamMessage` yields, and none of it was covered. These tests drive
 * the generator through a fake runtime, so any scenario can be scripted without
 * the SDK, the network, or an API key.
 */

const CONVERSATION_ID = 'conv-1';
const USER_ID = 'user-1';
/** The id of the assistant row a turn opens for itself. */
const TURN_ID = 'turn-1';
const WORKSPACE_ID = 'ws-1';

type Emitted = { event: string; data: Record<string, unknown> };

/** Drain the generator so ordering can be asserted directly. */
async function collect(
  gen: AsyncGenerator<unknown, void, unknown>,
): Promise<Emitted[]> {
  const out: Emitted[] = [];
  for await (const ev of gen) out.push(ev as Emitted);
  return out;
}

/** Every `message_stream` token concatenated — what the reader actually sees. */
function streamedText(events: Emitted[]): string {
  return events
    .filter((e) => e.event === 'message_stream')
    .map((e) => e.data.token as string)
    .join('');
}

function names(events: Emitted[]): string[] {
  return events.map((e) => e.event);
}

function textDeltas(...chunks: string[]): AgentEvent[] {
  return chunks.map((text) => ({ type: 'text_delta', text }) as AgentEvent);
}

/** Split a string into fixed-size chunks, to script a choppy stream. */
function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const DONE_EVENT = {
  type: 'done',
  usage: { inputTokens: 500, outputTokens: 500, costUsd: 0.01 },
} as AgentEvent;

interface Harness {
  service: MaestroService;
  setMessageMetadata: jest.Mock<Promise<void>, unknown[]>;
  /** Typed so `.mock.calls` indexes without falling back to `any`. */
  addMessage: jest.Mock<Promise<{ id: string }>, unknown[]>;
  /** The turn row is opened up front and FINISHED through these two. */
  updateMessage: jest.Mock<Promise<void>, unknown[]>;
  deleteMessage: jest.Mock<Promise<void>, unknown[]>;
  recordUsage: jest.Mock<Promise<void>, unknown[]>;
  getDecryptedKey: jest.Mock<Promise<string | null>, unknown[]>;
  runInputs: { systemPrompt: string | string[] }[];
  users: { getMaestroTone: jest.Mock };
  inbox: { sendDm: jest.Mock };
  /** The conversation list the history route reads. */
  listConversations: jest.Mock;
  /** The key store the settings routes reach. */
  keys: {
    getStatus: jest.Mock;
    setKey: jest.Mock;
    removeKey: jest.Mock;
    markOnboarded: jest.Mock;
  };
  /** The live-workspace load the key routes make after the capability check. */
  findDetail: jest.Mock;
}

function makeHarness(
  events: AgentEvent[],
  opts: {
    byokKey?: string | null;
    budgetExceeded?: boolean;
    /** Extra messages visible to the approval path. */
    messages?: unknown[];
    /** The tone stored on the user row; omit to leave the lookup unstubbed. */
    tone?: 'simple' | 'professional' | 'detailed';
    /** Stands in for the Slack connection the approved tool resolves. */
    slackConn?: unknown;
    /**
     * The role the caller holds. 'viewer' may not start a turn, 'removed' is
     * no longer in the workspace at all; default is a member.
     */
    role?: 'viewer' | 'removed' | 'admin' | 'owner';
  } = {},
): Harness {
  const runInputs: { systemPrompt: string | string[] }[] = [];
  const runtime = {
    run: (input: { systemPrompt: string | string[] }) => (
      runInputs.push(input),
      // eslint-disable-next-line @typescript-eslint/require-await -- scripted events, nothing to await
      (async function* () {
        for (const ev of events) yield ev;
      })()
    ),
  };
  // The service picks its runtime through the selector now (SDK or Messages
  // API). These tests are about what `streamMessage` does with the events,
  // which is identical either way, so both kinds resolve to the same fake.
  const runtimes = { forKind: () => runtime };

  // The assistant row gets a distinct id so a test can tell the turn row from
  // the user row it follows, and assert that `message_start` and
  // `message_complete` name the SAME one.
  const addMessage = jest
    .fn<Promise<{ id: string }>, unknown[]>()
    .mockImplementation((_conv: unknown, role: unknown) =>
      Promise.resolve({ id: role === 'assistant' ? TURN_ID : 'msg-saved' }),
    );
  const setMessageMetadata = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);
  const updateMessage = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);
  const deleteMessage = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);
  const listConversations = jest.fn().mockResolvedValue([]);
  const conversations = {
    list: listConversations,
    findById: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Existing title',
    }),
    addMessage,
    updateTitle: jest.fn().mockResolvedValue(undefined),
    // One prior turn, so `isFirstTurn` is false and no title is generated.
    getRecentMessages: jest.fn().mockResolvedValue(
      opts.messages ?? [
        { role: 'user', content: 'earlier', metadata: null },
        { role: 'user', content: 'current', metadata: null },
      ],
    ),
    setMessageMetadata,
    updateMessage,
    deleteMessage,
  };

  const recordUsage = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);
  const tokens = {
    checkBudget: jest
      .fn()
      .mockResolvedValue({ exceeded: Boolean(opts.budgetExceeded) }),
    recordUsage,
    getUsage: jest.fn().mockResolvedValue({ used: 10, limit: 1000 }),
  };

  const getDecryptedKey = jest
    .fn<Promise<string | null>, unknown[]>()
    .mockResolvedValue(opts.byokKey ?? null);

  // Tool factories run at input-build time and only capture these. The fake
  // runtime never calls a handler, so most stay empty — but the APPROVAL path
  // invokes a real handler, so inbox/slack need just enough to answer it.
  const stub = {} as never;
  const inbox = {
    resolveWorkspaceChannelToken: jest
      .fn()
      .mockResolvedValue(opts.slackConn ?? null),
    sendDm: jest.fn().mockResolvedValue({ ok: true }),
  } as never;
  const slack = {
    listAllChannels: jest
      .fn()
      .mockResolvedValue({ channels: [{ id: 'C1', name: 'general' }] }),
    joinChannel: jest.fn().mockResolvedValue(undefined),
  } as never;
  const users = {
    getMaestroTone: jest.fn().mockResolvedValue(opts.tone ?? 'professional'),
  };
  const groq = { isReady: () => false } as never;
  // A viewer holds only the read capabilities (the real role map), so the turn
  // gate (posts:draft) refuses them. Someone removed from the workspace is
  // refused everything.
  const heldRole: WorkspaceRole | null =
    opts.role === 'removed'
      ? null
      : opts.role === 'viewer'
        ? 'GUEST'
        : opts.role === 'admin'
          ? 'ADMIN'
          : opts.role === 'owner'
            ? 'OWNER'
            : 'MEMBER';
  const access = {
    assertCan: jest.fn((_ws: string, _user: string, cap: Capability) =>
      heldRole && roleCan(heldRole, cap)
        ? Promise.resolve(heldRole)
        : Promise.reject(new NotFoundException('Not found')),
    ),
  } as never;
  const roles = { getRole: jest.fn().mockResolvedValue(heldRole) } as never;
  const keys = {
    getDecryptedKey,
    getStatus: jest.fn().mockResolvedValue({ hasOwnKey: false }),
    setKey: jest.fn().mockResolvedValue({ hasOwnKey: true }),
    removeKey: jest.fn().mockResolvedValue({ hasOwnKey: false }),
    markOnboarded: jest.fn().mockResolvedValue({ onboarded: true }),
  };
  const findDetail = jest.fn().mockResolvedValue({ id: WORKSPACE_ID });

  const service = new MaestroService(
    runtimes as never,
    conversations as never,
    users as never,
    { findDetail } as never, // workspaceService
    tokens as never,
    groq,
    stub, // pexels
    stub, // unsplash
    stub, // tavily
    stub, // discord
    slack,
    stub, // posts
    inbox,
    stub, // conversationPresenter
    stub, // conversationList
    stub, // conversationDetail
    stub, // r2
    keys as never,
    stub, // channels
    stub, // campaigns
    stub, // libraryItems
    stub, // libraryTemplates
    stub, // librarySnippets
    stub, // libraryLinks
    stub, // libraryCategories
    stub, // scheduledMessages
    stub, // drips
    roles,
    access,
  );

  jest
    .spyOn(service, 'getUsage')
    .mockResolvedValue({ used: 10, limit: 1000 } as never);

  return {
    service,
    addMessage,
    updateMessage,
    deleteMessage,
    recordUsage,
    getDecryptedKey,
    setMessageMetadata,
    runInputs,
    users,
    inbox: inbox as unknown as { sendDm: jest.Mock },
    listConversations,
    keys,
    findDetail,
  };
}

function run(
  h: Harness,
  signal?: AbortSignal,
  approval?: { messageId: string; option: string },
) {
  return collect(
    h.service.streamMessage(
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        message: 'hi',
        ...(approval ? { approval } : {}),
      },
      signal ?? new AbortController().signal,
    ) as AsyncGenerator<unknown, void, unknown>,
  );
}

const CARD_ID = 'msg-card';
const YES = 'Yes, send it';

/** An assistant message holding an unresolved confirm card. */
function cardMessage(over: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
    role: 'assistant',
    content: null,
    metadata: {
      maestroQuestion: {
        questions: [
          {
            header: 'Confirm',
            question: 'Send "Hello" to #general on Slack?',
            options: [YES, 'No, cancel'],
            multiSelect: false,
          },
        ],
        pendingAction: {
          tool: 'send_slack_message',
          args: { channel: 'general', message: 'Hello' },
          yesLabel: YES,
        },
      },
      ...over,
    },
  };
}

describe('MaestroService.streamMessage', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform-key';
    delete process.env.MAESTRO_AUTH_MODE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('event ordering', () => {
    it('runs thinking, then text, then completion, then done', async () => {
      const h = makeHarness([
        { type: 'thinking_delta', text: 'considering' } as AgentEvent,
        ...textDeltas('Hello there'),
        DONE_EVENT,
      ]);

      const events = await run(h);

      expect(names(events)).toEqual([
        // The turn announces its row before it says anything, so a client can
        // name the reply it is about to stream even if it never completes.
        'message_start',
        'thinking',
        'message_stream',
        'message_complete',
        'done',
      ]);
    });

    it('announces the turn id before any content, and completes the same id', async () => {
      // The whole point of the up-front row: `message_complete` is the only
      // event that used to carry an id, and it never arrives on a stop.
      const h = makeHarness([...textDeltas('Hello'), DONE_EVENT]);

      const events = await run(h);

      expect(events[0].event).toBe('message_start');
      const started = (events[0].data as { messageId: string }).messageId;
      const completed = events.find((e) => e.event === 'message_complete');
      expect((completed?.data as { messageId: string }).messageId).toBe(
        started,
      );
    });

    it('reports a tool call and its result before any answer text', async () => {
      const h = makeHarness([
        {
          type: 'tool_call',
          name: 'send_slack_message',
          input: {},
        } as AgentEvent,
        {
          type: 'tool_result',
          name: 'send_slack_message',
          output: [{ type: 'text', text: '{"sent":true}' }],
          isError: false,
        } as AgentEvent,
        ...textDeltas('Sent.'),
        DONE_EVENT,
      ]);

      const events = await run(h);
      const order = names(events);

      expect(order.indexOf('tool_executing')).toBeLessThan(
        order.indexOf('tool_result'),
      );
      expect(order.indexOf('tool_result')).toBeLessThan(
        order.indexOf('message_stream'),
      );
      expect(events.find((e) => e.event === 'tool_executing')?.data).toEqual({
        tool: 'send_slack_message',
        input: {},
      });
    });

    it('always ends with done, after message_complete', async () => {
      const h = makeHarness([...textDeltas('Answer'), DONE_EVENT]);

      const events = await run(h);
      const order = names(events);

      expect(order[order.length - 1]).toBe('done');
      expect(order.indexOf('message_complete')).toBeLessThan(
        order.indexOf('done'),
      );
    });

    it('stops the stream dead on a runtime error', async () => {
      // Long enough to clear the marker-length tail hold-back, so some text
      // has genuinely been emitted before the error arrives.
      const h = makeHarness([
        ...textDeltas('A partial answer that was already streaming'),
        { type: 'error', message: 'model exploded' } as AgentEvent,
        // Nothing after an error may be emitted.
        ...textDeltas(' more'),
        DONE_EVENT,
      ]);

      const events = await run(h);

      expect(names(events)).toEqual([
        'message_start',
        'message_stream',
        'error',
      ]);
      expect(events[2].data).toEqual({ message: 'model exploded' });
    });

    it('emits no partial text when the error lands before the hold-back clears', async () => {
      // Under the marker length, so the tail hold-back is still holding it all
      // — the turn ends with the error and nothing visible.
      const h = makeHarness([
        ...textDeltas('short'),
        { type: 'error', message: 'model exploded' } as AgentEvent,
      ]);

      const events = await run(h);

      expect(names(events)).toEqual(['message_start', 'error']);
    });
  });

  describe('followups marker', () => {
    // The subtlest logic in the file: the marker separates the reply from its
    // suggestions, and a partial marker must never reach the reader.
    it('keeps the marker and everything after it out of the visible text', async () => {
      const h = makeHarness([
        ...textDeltas('The answer.__FOLLOWUPS__ one | two'),
        DONE_EVENT,
      ]);

      const events = await run(h);

      expect(streamedText(events)).toBe('The answer.');
      expect(streamedText(events)).not.toContain('__FOLLOWUPS__');
    });

    it('never leaks a marker split across two deltas', async () => {
      // This is why the loop holds back the tail: without it, `__FOLL` would
      // flash on screen before the rest of the marker arrived.
      const h = makeHarness([
        ...textDeltas('The answer.__FOLL', 'OWUPS__ one | two'),
        DONE_EVENT,
      ]);

      const events = await run(h);
      const visible = streamedText(events);

      expect(visible).toBe('The answer.');
      expect(visible).not.toContain('__FOLL');
    });

    it('leaks nothing even when the marker arrives one character at a time', async () => {
      const h = makeHarness([
        ...textDeltas('Answer.', ...'__FOLLOWUPS__ a | b'.split('')),
        DONE_EVENT,
      ]);

      const events = await run(h);
      const visible = streamedText(events);

      expect(visible).toBe('Answer.');
      // Not even a leading underscore of the marker may survive.
      expect(visible).not.toContain('_');
    });

    it('flushes the held-back tail when no marker ever arrives', async () => {
      // The tail hold-back must not silently truncate an ordinary reply.
      const full = 'A perfectly ordinary reply with no marker at all.';
      const h = makeHarness([...textDeltas(full), DONE_EVENT]);

      const events = await run(h);

      expect(streamedText(events)).toBe(full);
    });

    it('emits each character exactly once across many deltas', async () => {
      const full = 'Streamed in many small pieces, none duplicated.';
      const h = makeHarness([...textDeltas(...chunked(full, 3)), DONE_EVENT]);

      const events = await run(h);

      expect(streamedText(events)).toBe(full);
    });

    it('parses suggestions, strips bullets, and caps them at four', async () => {
      const h = makeHarness([
        ...textDeltas(
          'Done.__FOLLOWUPS__ - one | 2. two | three | four | five',
        ),
        DONE_EVENT,
      ]);

      const events = await run(h);
      const followups = events.find((e) => e.event === 'followups');

      expect(followups?.data.suggestions).toEqual([
        'one',
        'two',
        'three',
        'four',
      ]);
    });

    it('emits no followups event when there are none', async () => {
      const h = makeHarness([...textDeltas('Just an answer.'), DONE_EVENT]);

      const events = await run(h);

      expect(names(events)).not.toContain('followups');
    });

    it('persists only the display text, never the marker line', async () => {
      const h = makeHarness([
        ...textDeltas('Visible part.__FOLLOWUPS__ a | b'),
        DONE_EVENT,
      ]);

      const events = await run(h);
      const complete = events.find((e) => e.event === 'message_complete');

      expect(complete?.data.content).toBe('Visible part.');
      expect(h.updateMessage).toHaveBeenLastCalledWith(TURN_ID, {
        content: 'Visible part.',
        metadata: {
          maestroTurn: expect.objectContaining({ status: 'complete' }),
        },
        tokenCount: expect.any(Number),
      });
    });
  });

  describe('persistence', () => {
    /**
     * The metadata the turn wrote into its own row.
     *
     * The row is opened empty before the model runs and finished in place, so
     * what used to be the insert's 4th argument is now the update's `metadata`.
     */
    function savedMeta<T>(h: Harness): T | undefined {
      const calls = h.updateMessage.mock.calls.filter((c) => c[0] === TURN_ID);
      const last = calls[calls.length - 1];
      return (last?.[1] as { metadata?: T } | undefined)?.metadata;
    }

    it('reports the id the conversation store assigned', async () => {
      const h = makeHarness([...textDeltas('Saved.'), DONE_EVENT]);

      const events = await run(h);
      const complete = events.find((e) => e.event === 'message_complete');

      expect(complete?.data.messageId).toBe(TURN_ID);
    });

    it('still completes a turn that produced only media', async () => {
      // An image search with no prose must not vanish — the metadata is the
      // whole reply.
      const h = makeHarness([
        {
          type: 'tool_result',
          name: 'search_media',
          output: [
            {
              type: 'text',
              text: JSON.stringify({
                kind: 'media',
                items: [{ url: 'https://example.test/a.jpg' }],
                selectable: true,
                maxSelect: 1,
              }),
            },
          ],
          isError: false,
        } as AgentEvent,
        DONE_EVENT,
      ]);

      const events = await run(h);

      expect(names(events)).toContain('message_complete');
      const meta = savedMeta<{ maestroMedia: { items: unknown[] } }>(h);
      expect(meta?.maestroMedia.items).toHaveLength(1);
    });

    /**
     * A navigation leaves no trace on screen: the page simply changes. The
     * record of it lives only in the saved message, so these are the cases
     * where "the app moved and nobody can tell why" comes back.
     */
    const navResult = (payload: Record<string, unknown>) =>
      ({
        type: 'tool_result',
        name: 'navigate_to',
        output: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      }) as AgentEvent;

    it('records where the turn sent the user', async () => {
      const h = makeHarness([
        navResult({
          kind: 'navigate',
          ok: true,
          destination: 'settings-profile',
          reason: 'to change your picture',
        }),
        ...textDeltas('Opened it.'),
        DONE_EVENT,
      ]);

      await run(h);

      const meta = savedMeta<{
        maestroNavigated: { destination: string; reason?: string };
      }>(h);
      expect(meta?.maestroNavigated).toEqual({
        destination: 'settings-profile',
        reason: 'to change your picture',
      });
    });

    it('stores a destination name, never a URL', async () => {
      // Routes belong to the frontend. A path saved here would outlive the
      // build that knew it and send someone to a page that moved.
      const h = makeHarness([
        navResult({ kind: 'navigate', ok: true, destination: 'inbox' }),
        ...textDeltas('Here.'),
        DONE_EVENT,
      ]);

      await run(h);

      const meta = savedMeta(h);
      expect(JSON.stringify(meta)).not.toContain('/w/');
      expect(JSON.stringify(meta)).not.toContain('http');
    });

    it('keeps only the last of several navigations', async () => {
      // The user ends up at the second one. Recording the first would point
      // the record at a page they merely passed through.
      const h = makeHarness([
        navResult({ kind: 'navigate', ok: true, destination: 'planner' }),
        navResult({ kind: 'navigate', ok: true, destination: 'inbox' }),
        ...textDeltas('Done.'),
        DONE_EVENT,
      ]);

      await run(h);

      const meta = savedMeta<{ maestroNavigated: { destination: string } }>(h);
      expect(meta?.maestroNavigated.destination).toBe('inbox');
    });

    it('records nothing when the navigation was refused', async () => {
      // Nothing moved, so a record of a move would be a lie. The name is
      // deliberately present and valid-looking: a refusal that carried no
      // destination at all would be rejected by the type check anyway, and
      // would not exercise the `ok` guard this test exists for.
      const h = makeHarness([
        navResult({
          kind: 'navigate',
          ok: false,
          destination: 'settings-billing',
          error: 'refused',
        }),
        ...textDeltas('I could not open that.'),
        DONE_EVENT,
      ]);

      await run(h);

      const meta = savedMeta<{ maestroNavigated?: unknown }>(h);
      expect(meta?.maestroNavigated).toBeUndefined();
    });

    it('still completes a turn that only navigated', async () => {
      // If the model moves the page and says nothing, dropping the message
      // would erase the navigation with it.
      const h = makeHarness([
        navResult({ kind: 'navigate', ok: true, destination: 'drafts' }),
        DONE_EVENT,
      ]);

      const events = await run(h);

      expect(names(events)).toContain('message_complete');
      const meta = savedMeta<{ maestroNavigated: { destination: string } }>(h);
      expect(meta?.maestroNavigated.destination).toBe('drafts');
    });

    it('saves nothing extra when the turn produced no output at all', async () => {
      const h = makeHarness([DONE_EVENT]);

      const events = await run(h);

      // The turn opened a row for itself and then had nothing to put in it,
      // so that row is removed rather than left as an empty bubble.
      expect(h.updateMessage).not.toHaveBeenCalled();
      expect(h.deleteMessage).toHaveBeenCalledWith(TURN_ID);
      expect(names(events)).not.toContain('message_complete');
      expect(names(events)).toContain('done');
    });

    it('leaves exactly one assistant row for a completed turn', async () => {
      // The row is opened up front and finished in place. Inserting the reply
      // separately — as it once did — would leave the opened row behind empty.
      const h = makeHarness([...textDeltas('One row only.'), DONE_EVENT]);

      await run(h);

      const inserts = h.addMessage.mock.calls.filter(
        (c) => c[1] === 'assistant',
      );
      expect(inserts).toHaveLength(1);
      expect(inserts[0][2]).toBeNull();
      expect(h.deleteMessage).not.toHaveBeenCalled();
    });

    it('opens the turn row as running and closes it as complete', async () => {
      // The status is what a sweeper reads to tell an abandoned turn from a
      // finished one — a crash never reaches the `finally` that would close it.
      const h = makeHarness([...textDeltas('Done.'), DONE_EVENT]);

      await run(h);

      const opened = h.addMessage.mock.calls.find((c) => c[1] === 'assistant');
      expect(opened?.[3]).toMatchObject({
        maestroTurn: { status: 'running' },
      });
      const closed = savedMeta<{ maestroTurn: { status: string } }>(h);
      expect(closed?.maestroTurn.status).toBe('complete');
      expect(closed?.maestroTurn).toHaveProperty('endedAt');
    });

    it('closes the row as failed when the model errors out', async () => {
      // A failed turn used to leave nothing at all. Now its row exists, so it
      // must be closed here rather than left `running` for the sweeper.
      const h = makeHarness([
        ...textDeltas('A partial answer that was already streaming'),
        { type: 'error', message: 'model exploded' } as AgentEvent,
      ]);

      await run(h);

      const closed = savedMeta<{
        maestroTurn: { status: string };
        maestroStopped?: boolean;
      }>(h);
      expect(closed?.maestroTurn.status).toBe('failed');
      // Not a stop: the user did not interrupt this, so the panel must not
      // draw it as an answer they cut short.
      expect(closed?.maestroStopped).toBeUndefined();
    });
  });

  describe('metering', () => {
    it('converts agent tokens to user tokens at 100:1, rounding up', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT]);

      await run(h);

      // 500 in + 500 out = 1000 real → 10 user tokens.
      expect(h.recordUsage).toHaveBeenCalledWith(
        WORKSPACE_ID,
        USER_ID,
        10,
        'maestro_chat',
        expect.any(Object),
        { billable: true },
      );
    });

    it('never bills zero for a tiny turn', async () => {
      const h = makeHarness([
        ...textDeltas('ok'),
        {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        } as AgentEvent,
      ]);

      await run(h);

      expect(h.recordUsage.mock.calls[0][2]).toBe(1);
    });

    // A regression here silently double-charges: the workspace already paid
    // Anthropic directly with its own key.
    it('logs a BYOK turn without billing it', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        byokKey: 'sk-ant-workspace-key',
      });

      await run(h);

      expect(h.recordUsage).toHaveBeenCalledWith(
        WORKSPACE_ID,
        USER_ID,
        expect.any(Number),
        'maestro_chat',
        expect.any(Object),
        { billable: false },
      );
    });

    it('lets a BYOK workspace keep working past its plan allowance', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        byokKey: 'sk-ant-workspace-key',
        budgetExceeded: true,
      });

      const events = await run(h);

      expect(names(events)).not.toContain('error');
      expect(names(events)).toContain('message_complete');
    });

    it('blocks a platform-key workspace that is out of tokens', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        budgetExceeded: true,
      });

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
      // The turn is refused before anything is persisted.
      expect(h.addMessage).not.toHaveBeenCalled();
    });
  });

  describe('membership', () => {
    // Owning the conversation is not enough: its workspace may have removed
    // the caller since it was created.
    it('refuses a turn once the caller has left the workspace, and saves nothing', async () => {
      const h = makeHarness([...textDeltas('should not run'), DONE_EVENT], {
        role: 'removed',
      });

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
      expect(events[0].data.message).toContain('no longer a member');
      expect(h.addMessage).not.toHaveBeenCalled();
    });

    it('a viewer (GUEST) cannot start a Maestro turn, and nothing is saved', async () => {
      const h = makeHarness([...textDeltas('should not run'), DONE_EVENT], {
        role: 'viewer',
      });

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
      expect(h.addMessage).not.toHaveBeenCalled();
    });

    it('a member can start a Maestro turn', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT]);

      const events = await run(h);

      expect(names(events)).not.toContain('error');
    });

    it('refuses an approval once the caller has left the workspace, and runs nothing', async () => {
      const h = makeHarness([DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
        role: 'removed',
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      expect(names(events)).toEqual(['error']);
      expect(h.inbox.sendDm).not.toHaveBeenCalled();
    });
  });

  describe('the role copy', () => {
    it('a viewer (GUEST) is told their role cannot use Maestro, not that they left', async () => {
      const h = makeHarness([...textDeltas('should not run'), DONE_EVENT], {
        role: 'viewer',
      });

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
      expect(events[0].data.message).toBe(
        "Your role can't use Maestro in this workspace.",
      );
      expect(h.addMessage).not.toHaveBeenCalled();
    });

    it("a removed user's turn still says they are no longer a member", async () => {
      const h = makeHarness([...textDeltas('should not run'), DONE_EVENT], {
        role: 'removed',
      });

      const events = await run(h);

      expect(events[0].data.message).toBe(
        "You're no longer a member of this workspace.",
      );
    });
  });

  describe('history and the key', () => {
    it.each(['owner', 'admin', 'member'] as const)(
      "listConversations returns only the caller's own conversations (%s)",
      async (role) => {
        const h = makeHarness([DONE_EVENT], {
          role: role === 'member' ? undefined : role,
        });

        await h.service.listConversations(USER_ID, WORKSPACE_ID);

        expect(h.listConversations).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
      },
    );

    it('an ADMIN cannot read or set the workspace key (404, as assertCan answers)', async () => {
      const h = makeHarness([DONE_EVENT], { role: 'admin' });

      await expect(
        h.service.getKeyStatus(USER_ID, WORKSPACE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        h.service.setOwnKey(USER_ID, WORKSPACE_ID, 'sk-ant-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        h.service.removeOwnKey(USER_ID, WORKSPACE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        h.service.completeOnboarding(USER_ID, WORKSPACE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(h.keys.getStatus).not.toHaveBeenCalled();
      expect(h.keys.setKey).not.toHaveBeenCalled();
      expect(h.keys.removeKey).not.toHaveBeenCalled();
      expect(h.keys.markOnboarded).not.toHaveBeenCalled();
    });

    it('the OWNER can read, set and remove the key and finish onboarding', async () => {
      const h = makeHarness([DONE_EVENT], { role: 'owner' });

      await h.service.getKeyStatus(USER_ID, WORKSPACE_ID);
      await h.service.setOwnKey(USER_ID, WORKSPACE_ID, 'sk-ant-x');
      await h.service.removeOwnKey(USER_ID, WORKSPACE_ID);
      await h.service.completeOnboarding(USER_ID, WORKSPACE_ID);

      expect(h.keys.getStatus).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(h.keys.setKey).toHaveBeenCalledWith(WORKSPACE_ID, 'sk-ant-x');
      expect(h.keys.removeKey).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(h.keys.markOnboarded).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('the key routes load the live workspace by id, not by owner', async () => {
      const h = makeHarness([DONE_EVENT], { role: 'owner' });

      await h.service.getKeyStatus(USER_ID, WORKSPACE_ID);

      expect(h.findDetail).toHaveBeenCalledWith(WORKSPACE_ID);
    });
  });

  describe('auth failure', () => {
    it('reports a clean error and saves nothing when no key is configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT]);

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
      expect(events[0].data.message).toContain("isn't configured");
      // The whole point of resolving auth first: no orphan user turn.
      expect(h.addMessage).not.toHaveBeenCalled();
    });
  });

  describe('approval', () => {
    // The bug this whole path exists for: the model used to receive the
    // approval as chat text, and would produce a SECOND confirm card for an
    // action the user had already approved.
    it('performs the action itself, with no model turn at all', async () => {
      const h = makeHarness([...textDeltas('should not run'), DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });
      const order = names(events);

      expect(order).toContain('tool_executing');
      expect(order[order.length - 1]).toBe('done');
      // The scripted runtime text never appears — the model was not consulted.
      expect(streamedText(events)).not.toContain('should not run');
    });

    it('refuses an approved send when the caller is only a viewer, and sends nothing', async () => {
      const h = makeHarness([DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
        role: 'viewer',
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      // A viewer is stopped at the turn gate (posts:draft), before the
      // approval runs anything.
      expect(names(events)).toEqual(['error']);
      expect(h.inbox.sendDm).not.toHaveBeenCalled();
    });

    it('emits no second confirm card', async () => {
      const h = makeHarness([DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      const cards = events.filter(
        (e) =>
          e.event === 'tool_result' &&
          JSON.stringify(e.data).includes('"kind":"question"'),
      );
      expect(cards).toHaveLength(0);
    });

    it('marks the card resolved so the approval cannot be replayed', async () => {
      const h = makeHarness([DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      await run(h, undefined, { messageId: CARD_ID, option: YES });

      const [, meta] = h.setMessageMetadata.mock.calls[0] as [
        string,
        { maestroResolved?: { approved?: boolean } },
      ];
      expect(meta.maestroResolved?.approved).toBe(true);
    });

    it('runs nothing when the user cancels', async () => {
      const h = makeHarness([DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: 'No, cancel',
      });

      expect(names(events)).not.toContain('tool_executing');
      expect(names(events)).toContain('message_complete');
    });

    it('refuses an approval that was already resolved', async () => {
      // Replaying an approval must not send a second message.
      const h = makeHarness([...textDeltas('normal turn'), DONE_EVENT], {
        messages: [
          cardMessage({
            maestroResolved: { approved: true, at: '2026-08-27T00:00:00Z' },
          }),
        ],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      // Falls through to a normal turn rather than re-running the action.
      expect(streamedText(events)).toContain('normal turn');
    });

    it('ignores an approval naming a message from another conversation', async () => {
      const h = makeHarness([...textDeltas('normal turn'), DONE_EVENT], {
        messages: [cardMessage()],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: 'msg-from-somewhere-else',
        option: YES,
      });

      expect(streamedText(events)).toContain('normal turn');
    });

    // Stored metadata is untrusted input, not a capability token.
    it('refuses stored arguments that fail the tool schema', async () => {
      const h = makeHarness([...textDeltas('normal turn'), DONE_EVENT], {
        messages: [
          {
            id: CARD_ID,
            role: 'assistant',
            content: null,
            metadata: {
              maestroQuestion: {
                questions: [],
                pendingAction: {
                  tool: 'send_slack_message',
                  // `channel` must be a string; a tampered blob is rejected.
                  args: { channel: { $ne: null }, message: 'Hello' },
                  yesLabel: YES,
                },
              },
            },
          },
        ],
        slackConn: { accessToken: 'tok', channelId: 'ch-1' },
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      expect(streamedText(events)).toContain('normal turn');
      expect(h.setMessageMetadata).not.toHaveBeenCalled();
    });

    it('ignores an approval for a card that names an unknown tool', async () => {
      const h = makeHarness([...textDeltas('normal turn'), DONE_EVENT], {
        messages: [
          {
            id: CARD_ID,
            role: 'assistant',
            content: null,
            metadata: {
              maestroQuestion: {
                questions: [],
                pendingAction: {
                  tool: 'tool_that_does_not_exist',
                  args: {},
                  yesLabel: YES,
                },
              },
            },
          },
        ],
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: YES,
      });

      expect(streamedText(events)).toContain('normal turn');
    });

    // ask_user questions carry no pendingAction — they must not be treated
    // as approvals.
    it('ignores an approval pointing at an ask_user question', async () => {
      const h = makeHarness([...textDeltas('normal turn'), DONE_EVENT], {
        messages: [
          {
            id: CARD_ID,
            role: 'assistant',
            content: null,
            metadata: {
              maestroQuestion: {
                questions: [
                  {
                    header: 'Tone',
                    question: 'Which tone?',
                    options: ['Friendly', 'Formal'],
                    multiSelect: false,
                  },
                ],
              },
            },
          },
        ],
      });

      const events = await run(h, undefined, {
        messageId: CARD_ID,
        option: 'Friendly',
      });

      expect(streamedText(events)).toContain('normal turn');
    });
  });

  describe('reply tone', () => {
    /** The system prompt the runtime actually received, flattened. */
    function promptOf(h: Harness): string {
      const sent = h.runInputs[0].systemPrompt;
      return Array.isArray(sent) ? sent.join(String.fromCharCode(10)) : sent;
    }

    it('reads the tone from the user row, not the request body', async () => {
      // Tone must survive the bridge (Telegram/WhatsApp), which has no browser
      // to send a preference from -- so the DB is the only source of truth.
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        tone: 'simple',
      });

      await run(h);

      expect(h.users.getMaestroTone).toHaveBeenCalledWith(USER_ID);
      expect(promptOf(h)).toContain('Reply style: Simple');
    });

    it('adds nothing for the default voice', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        tone: 'professional',
      });

      await run(h);

      expect(promptOf(h)).not.toContain('Reply style');
    });

    it('keeps the static prompt first so the cache prefix is stable', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT], {
        tone: 'detailed',
      });

      await run(h);

      const sent = h.runInputs[0].systemPrompt;
      expect(Array.isArray(sent)).toBe(true);
      // A tone block inserted BEFORE the static prompt would invalidate the
      // cached prefix on every turn, for a cosmetic setting.
      expect((sent as string[])[0]).toContain('You are Maestro');
      expect(promptOf(h)).toContain('Reply style: Detailed');
    });

    it('still answers when the tone lookup fails', async () => {
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT]);
      h.users.getMaestroTone.mockRejectedValue(new Error('db down'));

      const events = await run(h);

      // A cosmetic preference must never take a chat turn down with it.
      expect(names(events)).not.toContain('error');
      expect(promptOf(h)).not.toContain('Reply style');
    });
  });

  describe('abort', () => {
    it('ends quietly, without an error event', async () => {
      const controller = new AbortController();
      const h = makeHarness([...textDeltas('Hi'), DONE_EVENT]);
      controller.abort();

      const events = await run(h, controller.signal);

      expect(names(events)).not.toContain('error');
    });

    /**
     * Pressing Stop is how the controller behaves: it aborts the signal and
     * BREAKS out of its `for await`. Breaking a for-await calls `.return()`
     * on the generator, so it is torn down at whichever `yield` it is
     * sitting on — and every line after the loop, the save included, is
     * skipped. `run()` above cannot show this, because it drains the
     * generator to completion, which a stopped turn never reaches.
     */
    async function stopAfter(h: Harness, n: number): Promise<void> {
      const controller = new AbortController();
      const gen = h.service.streamMessage(
        { conversationId: CONVERSATION_ID, userId: USER_ID, message: 'hi' },
        controller.signal,
      ) as AsyncGenerator<unknown, void, unknown>;

      let seen = 0;
      for await (const _ev of gen) {
        if (++seen >= n) {
          controller.abort();
          break; // exactly what maestro.controller.ts does
        }
      }
    }

    /**
     * What this turn wrote into its own assistant row.
     *
     * The row is OPENED empty before the model runs and finished in place, so
     * the content lands in `updateMessage`, not in an insert.
     */
    function assistantSaves(h: Harness): unknown[][] {
      return h.updateMessage.mock.calls.filter((c) => c[0] === TURN_ID);
    }

    it('keeps what a stopped turn had already written', async () => {
      // The failure this guards: the text was on screen and gone on
      // reload, leaving a question with no reply at all.
      const h = makeHarness([
        ...textDeltas('Here is ', 'your week'),
        DONE_EVENT,
      ]);

      await stopAfter(h, 2);

      const [saved] = assistantSaves(h);
      expect(saved).toBeDefined();
      expect((saved[1] as { content: string }).content).toContain('Here is');
    });

    it('marks the saved row as stopped', async () => {
      // So the panel can draw it as an interrupted answer after a reload,
      // rather than as a reply that merely ended early.
      const h = makeHarness([...textDeltas('Half an ', 'answer'), DONE_EVENT]);

      await stopAfter(h, 2);

      expect(
        (assistantSaves(h)[0][1] as { metadata: unknown }).metadata,
      ).toMatchObject({
        maestroStopped: true,
        maestroTurn: { status: 'stopped' },
      });
    });

    it('writes nothing when the turn was stopped before it spoke', async () => {
      // An empty assistant row is worse than none: it reads as Maestro
      // having answered with silence. The row this turn opened for itself is
      // removed rather than left behind blank.
      const h = makeHarness([...textDeltas('   '), DONE_EVENT]);

      await stopAfter(h, 1);

      expect(assistantSaves(h)).toHaveLength(0);
      expect(h.deleteMessage).toHaveBeenCalledWith(TURN_ID);
    });

    /**
     * A stopped turn is still PAID for.
     *
     * The tokens are spent at Anthropic the moment the model runs, so a turn
     * the user cuts short costs real money. Metering used to sit on the
     * success path only — and the teardown that skips the save skips that
     * line too — so pressing Stop was a way to use Maestro for nothing, and
     * the exploit was "press Stop on every turn".
     *
     * The spend is known mid-flight because the runtime reports a running
     * total as it accrues; without that the service would be charging an
     * estimate.
     */
    const USAGE_EVENT = {
      type: 'usage',
      usage: { inputTokens: 400, outputTokens: 200, costUsd: 0 },
    } as AgentEvent;

    it('bills a stopped turn for what it had really spent', async () => {
      // The usage lands first — as it does live, where the runtime reports
      // the running total as each assistant message arrives — and the stop
      // comes well before the stream would have ended.
      const h = makeHarness([
        USAGE_EVENT,
        ...textDeltas('one ', 'two ', 'three ', 'four ', 'five ', 'six '),
        DONE_EVENT,
      ]);

      await stopAfter(h, 2);

      // 400 in + 200 out = 600 real → 6 user tokens, charged even though
      // `done` never arrived.
      expect(h.recordUsage).toHaveBeenCalledWith(
        WORKSPACE_ID,
        USER_ID,
        6,
        'maestro_chat',
        expect.any(Object),
        { billable: true },
      );
    });

    it('charges a stopped turn once, not twice', async () => {
      // The `finally` runs on every path, including the one that already
      // metered — a second charge would bill the same tokens twice.
      const h = makeHarness([
        USAGE_EVENT,
        ...textDeltas('All of it'),
        DONE_EVENT,
      ]);

      await run(h);

      expect(h.recordUsage).toHaveBeenCalledTimes(1);
    });

    it('bills nothing when the turn was stopped before the model ran', async () => {
      // No usage reported means no tokens were spent — charging the 1-token
      // floor here would invent a cost the workspace never incurred. No
      // `done` is scripted precisely because that is the case being pinned:
      // a turn cut short before any spend was reported at all.
      const h = makeHarness(
        textDeltas('one ', 'two ', 'three ', 'four ', 'five ', 'six '),
      );

      await stopAfter(h, 1);

      expect(h.recordUsage).not.toHaveBeenCalled();
    });

    it('does not bill a stopped BYOK turn', async () => {
      // The workspace already paid Anthropic with its own key; the rescue
      // must honour that the same way the success path does.
      const h = makeHarness(
        [
          USAGE_EVENT,
          ...textDeltas('one ', 'two ', 'three ', 'four ', 'five ', 'six '),
          DONE_EVENT,
        ],
        { byokKey: 'sk-ant-workspace-key' },
      );

      await stopAfter(h, 2);

      expect(h.recordUsage).toHaveBeenCalledWith(
        WORKSPACE_ID,
        USER_ID,
        expect.any(Number),
        'maestro_chat',
        expect.any(Object),
        { billable: false },
      );
    });

    it('does not save the answer twice', async () => {
      // A turn that finishes normally saves below, with its full metadata.
      // If the rescue fired as well, the thread would hold the reply twice.
      const h = makeHarness([...textDeltas('All done'), DONE_EVENT]);

      await run(h);

      expect(assistantSaves(h)).toHaveLength(1);
    });
  });
});
