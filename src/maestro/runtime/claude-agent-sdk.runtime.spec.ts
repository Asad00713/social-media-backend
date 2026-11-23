import {
  ClaudeAgentSdkRuntime,
  __setSdkLoaderForTests,
} from './claude-agent-sdk.runtime';
import type { AgentEvent, AgentRunInput } from '../maestro.types';

/**
 * The adapter's job is translation: SDK messages in, normalized `AgentEvent`s
 * out. Everything it must carry across that boundary is something a consumer
 * cannot recover on its own — which is exactly what went wrong with the tool
 * name below.
 */

const mockQuery = jest.fn();

/** The three SDK entry points this adapter touches. */
const fakeSdk = () =>
  Promise.resolve({
    query: (...args: unknown[]) => mockQuery(...args) as unknown,
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (opts: unknown) => opts,
  } as never);

/**
 * The runtime reaches the SDK through a dynamic `import()` — the package is
 * ESM-only and this build is CommonJS. Jest cannot intercept that without
 * `--experimental-vm-modules`, so the adapter exposes a loader seam and the
 * fake goes in through that.
 *
 * That indirection is why the adapter had no tests, and why a `tool_result`
 * carrying no tool name reached production.
 */
beforeAll(() => {
  __setSdkLoaderForTests(fakeSdk);
});

afterAll(() => __setSdkLoaderForTests(null));

/** Feed the adapter a scripted sequence of SDK messages. */
function scriptMessages(messages: unknown[]) {
  // An async iterator is what the SDK hands back; these messages are already
  // in hand, so there is nothing here to await.
  mockQuery.mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  });
}

function assistantToolUse(id: string, name: string) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  };
}

function userToolResult(toolUseId: string, text = 'ok', isError = false) {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text }],
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

const INPUT: AgentRunInput = {
  ctx: { userId: 'u1', workspaceId: 'ws-1' },
  systemPrompt: 'sys',
  history: [],
  userMessage: 'hi',
  tools: [],
  model: 'claude-haiku-4-5',
  env: {},
};

async function collect(input: AgentRunInput = INPUT): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of new ClaudeAgentSdkRuntime().run(input)) out.push(ev);
  return out;
}

describe('ClaudeAgentSdkRuntime', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Re-plant the loader: the adapter caches the resolved SDK, and a reset
    // between tests would otherwise be the only thing to clear it.
    __setSdkLoaderForTests(fakeSdk);
  });

  describe('tool_result events', () => {
    // Anthropic's tool_result block carries only a tool_use_id; the name is on
    // the tool_use block that opened the call. The adapter used to hard-code
    // `name: ''`, so a consumer could not tell which tool had finished — the
    // panel's step timeline left every row spinning forever.
    it('names the tool a result belongs to', async () => {
      scriptMessages([
        assistantToolUse('call-1', 'list_channels'),
        userToolResult('call-1'),
      ]);

      const events = await collect();
      const result = events.find((e) => e.type === 'tool_result');

      expect(result).toMatchObject({ id: 'call-1', name: 'list_channels' });
    });

    it('names each result when several tools run in one turn', async () => {
      scriptMessages([
        assistantToolUse('call-1', 'list_channels'),
        assistantToolUse('call-2', 'list_campaigns'),
        userToolResult('call-2'),
        userToolResult('call-1'),
      ]);

      const events = await collect();
      const names = events
        .filter((e) => e.type === 'tool_result')
        .map((e) => (e as { id: string; name: string }).name);

      // Results come back out of order — matched by id, not by arrival.
      expect(names).toEqual(['list_campaigns', 'list_channels']);
    });

    it('carries the error flag through', async () => {
      scriptMessages([
        assistantToolUse('call-1', 'list_channels'),
        userToolResult('call-1', 'boom', true),
      ]);

      const events = await collect();
      const result = events.find((e) => e.type === 'tool_result');

      expect(result).toMatchObject({ name: 'list_channels', isError: true });
    });

    // A result with no matching call is still a result: dropping the name is
    // better than dropping the event, which would leave the caller waiting.
    it('emits a result with an empty name when the call was never seen', async () => {
      scriptMessages([userToolResult('orphan')]);

      const events = await collect();
      const result = events.find((e) => e.type === 'tool_result');

      expect(result).toMatchObject({ id: 'orphan', name: '' });
    });
  });

  it('emits a tool_call naming the tool', async () => {
    scriptMessages([assistantToolUse('call-1', 'list_channels')]);

    const events = await collect();

    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({
      id: 'call-1',
      name: 'list_channels',
    });
  });

  /**
   * What a STOPPED turn is charged.
   *
   * A stopped turn never reaches the `result` message, so the running total
   * built from these `usage` events is the only figure there is — and it is
   * billed. Every case below has been wrong in this file at some point, and
   * none of them could be seen from the outside: a COMPLETED turn overwrites
   * the running total with the SDK's own aggregate, so an error here is
   * invisible until someone presses Stop.
   */
  describe('usage it reports as the turn runs', () => {
    function assistantWithUsage(
      id: string,
      usage: Record<string, number>,
      text = 'hi',
    ) {
      return {
        type: 'assistant',
        message: { id, content: [{ type: 'text', text }], usage },
      };
    }

    function lastUsage(events: AgentEvent[]) {
      const usages = events.filter((e) => e.type === 'usage');
      return usages.length
        ? (usages[usages.length - 1] as Extract<AgentEvent, { type: 'usage' }>)
            .usage
        : null;
    }

    it('sums input across steps, because each step is its own priced request', async () => {
      // Taking only the last step's figure under-bills by every earlier step,
      // and worst on the longest turns. Anthropic's own cost-tracking
      // guidance accumulates per-step input for exactly this reason.
      scriptMessages([
        assistantWithUsage('m1', { input_tokens: 100, output_tokens: 10 }),
        assistantWithUsage('m2', { input_tokens: 150, output_tokens: 20 }),
      ]);

      expect(lastUsage(await collect())).toMatchObject({
        inputTokens: 250,
        outputTokens: 30,
      });
    });

    it('counts a step once even when it called several tools', async () => {
      // A step that calls several tools emits one assistant message per tool,
      // ALL carrying that step's usage under the same message id. This is the
      // one place summing really would double-count.
      scriptMessages([
        assistantWithUsage('same-step', {
          input_tokens: 100,
          output_tokens: 10,
        }),
        assistantWithUsage('same-step', {
          input_tokens: 100,
          output_tokens: 10,
        }),
      ]);

      expect(lastUsage(await collect())).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
      });
    });

    it('counts the cached prefix, which is carved out of input_tokens', async () => {
      // `input_tokens` holds only what came AFTER the last cache breakpoint.
      // Reading it alone makes a long cached turn look nearly free.
      scriptMessages([
        assistantWithUsage('m1', {
          input_tokens: 50,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 1000,
          output_tokens: 5,
        }),
      ]);

      expect(lastUsage(await collect())).toMatchObject({
        inputTokens: 10050,
        outputTokens: 5,
      });
    });

    it('reports usage before the turn ends, so a stop has a figure to bill', async () => {
      // The whole reason this event exists: `done` never arrives on a stop.
      scriptMessages([
        assistantWithUsage('m1', { input_tokens: 100, output_tokens: 10 }),
      ]);

      const events = await collect();

      expect(events.findIndex((e) => e.type === 'usage')).toBeGreaterThanOrEqual(
        0,
      );
      expect(events.some((e) => e.type === 'done')).toBe(false);
    });

    it('lets the SDK aggregate win once the turn completes', async () => {
      // `result.usage` is already totalled across steps, so `done` ASSIGNS it
      // rather than adding — adding would double the whole turn.
      scriptMessages([
        assistantWithUsage('m1', { input_tokens: 100, output_tokens: 10 }),
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 120, output_tokens: 12 },
          total_cost_usd: 0.004,
        },
      ]);

      const events = await collect();
      const done = events.find((e) => e.type === 'done') as Extract<
        AgentEvent,
        { type: 'done' }
      >;

      expect(done.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 12,
        costUsd: 0.004,
      });
    });
  });
});
