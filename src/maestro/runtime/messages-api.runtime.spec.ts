import { z } from 'zod';
import { MessagesApiRuntime } from './messages-api.runtime';
import { MAESTRO_API_RUNTIME_KEY_ENV } from '../auth/agent-auth';
import type {
  AgentEvent,
  AgentRunInput,
  AgentToolDefinition,
} from '../maestro.types';

/**
 * The Agent SDK gave us the agentic loop; here it is written by hand, so the
 * parts it used to own are the parts that can now be wrong: feeding tool
 * results back, replaying the assistant turn verbatim (thinking blocks carry
 * signatures the API verifies), accumulating usage across round trips, and
 * stopping. Each of those is a test below.
 */

/** The request body the runtime sent, as far as these tests inspect it. */
interface SentBody {
  messages: Array<Record<string, unknown>>;
  tools: Array<{
    name: string;
    input_schema: { properties?: Record<string, { description?: string }> };
  }>;
  thinking?: { type: string; budget_tokens: number };
  max_tokens: number;
}

const mockStream = jest.fn<unknown, [SentBody, ...unknown[]]>();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class {
    messages = {
      stream: (body: SentBody, ...rest: unknown[]) => mockStream(body, ...rest),
    };
  },
}));

/** One streamed reply: the deltas it emits, then the message it settles to. */
function scriptReply(opts: {
  deltas?: Array<
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
  >;
  content: unknown[];
  inputTokens?: number;
  outputTokens?: number;
}) {
  const events = (opts.deltas ?? []).map((delta) => ({
    type: 'content_block_delta' as const,
    delta,
  }));
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- scripted
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
    finalMessage: () =>
      Promise.resolve({
        content: opts.content,
        usage: {
          input_tokens: opts.inputTokens ?? 10,
          output_tokens: opts.outputTokens ?? 5,
        },
      }),
  };
}

const tool = (
  over: Partial<AgentToolDefinition> = {},
): AgentToolDefinition => ({
  name: 'list_posts',
  description: 'List posts',
  inputSchema: { status: z.string().optional().describe('Filter by status') },
  handler: () => Promise.resolve({ posts: [] }),
  ...over,
});

const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  ctx: { userId: 'u-1', workspaceId: 'w-1' },
  systemPrompt: 'You are Maestro.',
  history: [],
  userMessage: 'what is scheduled?',
  tools: [tool()],
  model: 'claude-sonnet-4-5',
  env: { ANTHROPIC_API_KEY: 'sk-test' },
  ...over,
});

async function collect(input: AgentRunInput): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of new MessagesApiRuntime().run(input)) out.push(ev);
  return out;
}

/** The text a tool_result event carries, through its content blocks. */
function textOf(ev: AgentEvent | undefined): string {
  if (ev?.type !== 'tool_result') throw new Error('not a tool_result');
  return ev.output.map((b) => b.text).join('');
}

/** The `messages` array of the Nth API call. */
function messagesOfCall(n: number): Array<Record<string, unknown>> {
  return mockStream.mock.calls[n][0].messages;
}

describe('MessagesApiRuntime', () => {
  beforeEach(() => mockStream.mockReset());

  describe('the event stream it produces', () => {
    it('yields text and thinking deltas as they stream', async () => {
      mockStream.mockReturnValue(
        scriptReply({
          deltas: [
            { type: 'thinking_delta', thinking: 'Let me check.' },
            { type: 'text_delta', text: 'Two posts' },
          ],
          content: [{ type: 'text', text: 'Two posts' }],
        }),
      );

      const events = await collect(input());
      expect(events.map((e) => e.type)).toEqual([
        'thinking_delta',
        'text_delta',
        'done',
      ]);
    });

    it('reports a tool call and its result, then the answer', async () => {
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
            ],
          }),
        )
        .mockReturnValueOnce(
          scriptReply({
            deltas: [{ type: 'text_delta', text: 'Nothing scheduled.' }],
            content: [{ type: 'text', text: 'Nothing scheduled.' }],
          }),
        );

      const events = await collect(input());
      expect(events.map((e) => e.type)).toEqual([
        'tool_call',
        'tool_result',
        'text_delta',
        'done',
      ]);
    });

    it('errors rather than calling out with no key', async () => {
      const events = await collect(input({ env: {} }));
      expect(events).toEqual([
        {
          type: 'error',
          message:
            'Maestro is not configured: the API runtime needs an Anthropic API key.',
        },
      ]);
      expect(mockStream).not.toHaveBeenCalled();
    });

    // Local dev runs MAESTRO_AUTH_MODE=subscription, which strips
    // ANTHROPIC_API_KEY so the SDK subprocess uses Claude Code's OAuth. This
    // runtime has no OAuth path, so it must find the key parked aside — or it
    // is dead in exactly the setup it gets developed in.
    // The consumer digs the tool's JSON out of a text block to find
    // references, media, question cards and web results. A bare string parses
    // as none of those — the answer arrives with its links hollowed out.
    it('yields tool output as content blocks, not a bare string', async () => {
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
            ],
            stopReason: 'tool_use',
          }),
        )
        .mockReturnValueOnce(
          scriptReply({ content: [{ type: 'text', text: 'Done' }] }),
        );

      const events = await collect(
        input({
          tools: [
            tool({ handler: () => Promise.resolve({ kind: 'reference' }) }),
          ],
        }),
      );

      const result = events.find((e) => e.type === 'tool_result');
      expect(Array.isArray((result as { output: unknown }).output)).toBe(true);
      expect(result).toMatchObject({
        output: [{ type: 'text', text: '{"kind":"reference"}' }],
      });
    });

    it('uses the key parked aside by subscription mode', async () => {
      mockStream.mockReturnValue(
        scriptReply({
          deltas: [{ type: 'text_delta', text: 'Two posts' }],
          content: [{ type: 'text', text: 'Two posts' }],
        }),
      );

      const events = await collect(
        input({ env: { [MAESTRO_API_RUNTIME_KEY_ENV]: 'sk-parked' } }),
      );

      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    });
  });

  describe('the loop', () => {
    it('feeds the tool result back so the model can answer', async () => {
      const handler = jest
        .fn<Promise<unknown>, unknown[]>()
        .mockResolvedValue({ posts: ['a'] });
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              {
                type: 'tool_use',
                id: 't-1',
                name: 'list_posts',
                input: { status: 'draft' },
              },
            ],
          }),
        )
        .mockReturnValueOnce(
          scriptReply({ content: [{ type: 'text', text: 'One draft.' }] }),
        );

      await collect(input({ tools: [tool({ handler })] }));

      // The tool ran with the model's own arguments...
      expect(handler).toHaveBeenCalledWith(
        { status: 'draft' },
        { userId: 'u-1', workspaceId: 'w-1' },
      );
      // ...and its result went back as a tool_result the model can read.
      const second = messagesOfCall(1);
      const last = second[second.length - 1];
      expect(last.role).toBe('user');
      const blocks = last.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 't-1',
      });
      expect(String(blocks[0].content)).toContain('posts');
    });

    it('replays the assistant turn verbatim, thinking blocks included', async () => {
      // The API verifies a thinking block's signature against the tool result
      // that follows it. Dropping or rewriting the block rejects the request.
      const thinking = {
        type: 'thinking',
        thinking: 'I should look this up.',
        signature: 'sig-abc',
      };
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              thinking,
              { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
            ],
          }),
        )
        .mockReturnValueOnce(
          scriptReply({ content: [{ type: 'text', text: 'Done.' }] }),
        );

      await collect(input());

      const second = messagesOfCall(1);
      const assistant = second[second.length - 2];
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toContainEqual(thinking);
    });

    it('surfaces a failed tool as a result, not a dead turn', async () => {
      // The model can read "that failed" and try something else; a throw would
      // abandon the answer mid-turn.
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
            ],
          }),
        )
        .mockReturnValueOnce(
          scriptReply({ content: [{ type: 'text', text: 'Sorry.' }] }),
        );

      const events = await collect(
        input({
          tools: [
            tool({ handler: () => Promise.reject(new Error('DB is down')) }),
          ],
        }),
      );

      const result = events.find((e) => e.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain('DB is down');
      // The turn still finished.
      expect(events[events.length - 1].type).toBe('done');
    });

    it('answers a tool the model invented instead of crashing', async () => {
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              { type: 'tool_use', id: 't-1', name: 'no_such_tool', input: {} },
            ],
          }),
        )
        .mockReturnValueOnce(
          scriptReply({ content: [{ type: 'text', text: 'Never mind.' }] }),
        );

      const events = await collect(input());
      const result = events.find((e) => e.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(events[events.length - 1].type).toBe('done');
    });

    it('stops at maxTurns rather than looping forever', async () => {
      // A model that keeps calling tools must not run up an unbounded bill.
      mockStream.mockReturnValue(
        scriptReply({
          content: [
            { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
          ],
        }),
      );

      const events = await collect(input({ maxTurns: 3 }));
      expect(mockStream).toHaveBeenCalledTimes(3);
      expect(events[events.length - 1].type).toBe('done');
    });
  });

  describe('what it reports back', () => {
    it('adds up usage across every round trip', async () => {
      // The user is billed for the turn, not for each call inside it.
      mockStream
        .mockReturnValueOnce(
          scriptReply({
            content: [
              { type: 'tool_use', id: 't-1', name: 'list_posts', input: {} },
            ],
            inputTokens: 100,
            outputTokens: 20,
          }),
        )
        .mockReturnValueOnce(
          scriptReply({
            content: [{ type: 'text', text: 'Done.' }],
            inputTokens: 150,
            outputTokens: 30,
          }),
        );

      const events = await collect(input());
      const done = events[events.length - 1] as Extract<
        AgentEvent,
        { type: 'done' }
      >;
      expect(done.usage.inputTokens).toBe(250);
      expect(done.usage.outputTokens).toBe(50);
      expect(done.usage.costUsd).toBeGreaterThan(0);
    });

    it('prices an unknown model rather than reporting it as free', async () => {
      mockStream.mockReturnValue(
        scriptReply({
          content: [{ type: 'text', text: 'hi' }],
          inputTokens: 1000,
          outputTokens: 1000,
        }),
      );

      const events = await collect(input({ model: 'claude-something-new' }));
      const done = events[events.length - 1] as Extract<
        AgentEvent,
        { type: 'done' }
      >;
      expect(done.usage.costUsd).toBeGreaterThan(0);
    });
  });

  describe('what it sends', () => {
    it('turns a Zod shape into a schema keeping descriptions', async () => {
      // The model chooses arguments by reading these; losing them quietly
      // makes it worse at picking them.
      mockStream.mockReturnValue(
        scriptReply({ content: [{ type: 'text', text: 'hi' }] }),
      );

      await collect(input());
      const tools = mockStream.mock.calls[0][0].tools;
      expect(tools[0].name).toBe('list_posts');
      expect(tools[0].input_schema.properties?.status?.description).toBe(
        'Filter by status',
      );
    });

    it('replays history as real turns', async () => {
      mockStream.mockReturnValue(
        scriptReply({ content: [{ type: 'text', text: 'hi' }] }),
      );

      await collect(
        input({
          history: [
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
          ],
        }),
      );

      const sent = messagesOfCall(0);
      expect(sent).toHaveLength(3);
      expect(sent[0]).toEqual({ role: 'user', content: 'earlier question' });
      expect(sent[1]).toEqual({
        role: 'assistant',
        content: 'earlier answer',
      });
    });

    it('asks for thinking, so it reasons like the SDK does', async () => {
      mockStream.mockReturnValue(
        scriptReply({ content: [{ type: 'text', text: 'hi' }] }),
      );

      await collect(input());
      const body = mockStream.mock.calls[0][0];
      expect(body.thinking?.type).toBe('enabled');
      // Must leave room for the answer on top of the thinking budget, or the
      // API rejects the request outright.
      expect(body.max_tokens).toBeGreaterThan(body.thinking!.budget_tokens);
    });
  });
});
