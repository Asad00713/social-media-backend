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
  recordUsage: jest.Mock<Promise<void>, unknown[]>;
  getDecryptedKey: jest.Mock<Promise<string | null>, unknown[]>;
  runInputs: { systemPrompt: string | string[] }[];
  users: { getMaestroTone: jest.Mock };
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

  const addMessage = jest
    .fn<Promise<{ id: string }>, unknown[]>()
    .mockResolvedValue({ id: 'msg-saved' });
  const setMessageMetadata = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);
  const conversations = {
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

  const service = new MaestroService(
    runtime as never,
    conversations as never,
    users as never,
    stub, // workspaceService
    tokens as never,
    groq,
    stub, // pexels
    stub, // unsplash
    stub, // tavily
    stub, // discord
    slack,
    stub, // posts
    inbox,
    stub, // r2
    { getDecryptedKey } as never,
    stub, // channels
    stub, // campaigns
  );

  jest
    .spyOn(service, 'getUsage')
    .mockResolvedValue({ used: 10, limit: 1000 } as never);

  return {
    service,
    addMessage,
    recordUsage,
    getDecryptedKey,
    setMessageMetadata,
    runInputs,
    users,
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
        'thinking',
        'message_stream',
        'message_complete',
        'done',
      ]);
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
      expect(events[0].data).toEqual({
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

      expect(names(events)).toEqual(['message_stream', 'error']);
      expect(events[1].data).toEqual({ message: 'model exploded' });
    });

    it('emits no partial text when the error lands before the hold-back clears', async () => {
      // Under the marker length, so the tail hold-back is still holding it all
      // — the turn ends with the error and nothing visible.
      const h = makeHarness([
        ...textDeltas('short'),
        { type: 'error', message: 'model exploded' } as AgentEvent,
      ]);

      const events = await run(h);

      expect(names(events)).toEqual(['error']);
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
      expect(h.addMessage).toHaveBeenLastCalledWith(
        CONVERSATION_ID,
        'assistant',
        'Visible part.',
        undefined,
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('persistence', () => {
    it('reports the id the conversation store assigned', async () => {
      const h = makeHarness([...textDeltas('Saved.'), DONE_EVENT]);

      const events = await run(h);
      const complete = events.find((e) => e.event === 'message_complete');

      expect(complete?.data.messageId).toBe('msg-saved');
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
      const meta = h.addMessage.mock.calls[1][3] as {
        maestroMedia: { items: unknown[] };
      };
      expect(meta.maestroMedia.items).toHaveLength(1);
    });

    it('saves nothing extra when the turn produced no output at all', async () => {
      const h = makeHarness([DONE_EVENT]);

      const events = await run(h);

      // Only the inbound user turn was persisted.
      expect(h.addMessage).toHaveBeenCalledTimes(1);
      expect(names(events)).not.toContain('message_complete');
      expect(names(events)).toContain('done');
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
  });
});
