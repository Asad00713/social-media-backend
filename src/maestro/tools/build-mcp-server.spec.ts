import {
  buildMcpServer,
  MCP_SERVER_NAME,
  stripQualifiedToolName,
  toQualifiedToolName,
} from './build-mcp-server';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

/**
 * Stands in for the Agent SDK. The real module is ESM-only and slow to load,
 * and none of its behaviour is under test here — what matters is which handler
 * and which context `buildMcpServer` wires together, so the stub just records
 * the handler it is handed.
 */
function makeSdk() {
  const handlers = new Map<string, Handler>();
  const sdk = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return { name };
    },
    createSdkMcpServer: (cfg: unknown) => ({ created: cfg }),
  };
  return { sdk: sdk as never, handlers };
}

function def(
  name: string,
  handler: AgentToolDefinition['handler'],
): AgentToolDefinition {
  return { name, description: `${name} tool`, inputSchema: {}, handler };
}

describe('buildMcpServer', () => {
  describe('tenant isolation', () => {
    // The reason this file exists. Every request builds its own server whose
    // handlers close over THAT request's context. If a context were ever
    // hoisted or shared, one workspace would act with another's identity.
    it('gives each handler the context its own server was built with', async () => {
      const seen: ToolContext[] = [];
      const capture = def('whoami', async (_args, ctx) => {
        seen.push(ctx);
        return { ok: true };
      });

      const alice: ToolContext = { userId: 'u-alice', workspaceId: 'ws-alice' };
      const bob: ToolContext = { userId: 'u-bob', workspaceId: 'ws-bob' };

      const a = makeSdk();
      buildMcpServer(a.sdk, [capture], alice);
      const b = makeSdk();
      buildMcpServer(b.sdk, [capture], bob);

      await a.handlers.get('whoami')!({});
      await b.handlers.get('whoami')!({});

      expect(seen).toHaveLength(2);
      // Identity, not a field comparison: this fails if the closure captured a
      // shared reference even when the field values happen to match.
      expect(seen[0]).toBe(alice);
      expect(seen[1]).toBe(bob);
    });

    it('does not let a later build change an earlier context', async () => {
      const seen: ToolContext[] = [];
      const capture = def('whoami', async (_args, ctx) => {
        seen.push(ctx);
        return {};
      });

      const first: ToolContext = { userId: 'u-1', workspaceId: 'ws-1' };
      const a = makeSdk();
      buildMcpServer(a.sdk, [capture], first);

      // A second request comes in before the first server's tool is called.
      const b = makeSdk();
      buildMcpServer(b.sdk, [capture], {
        userId: 'u-2',
        workspaceId: 'ws-2',
      });

      await a.handlers.get('whoami')!({});

      expect(seen[0]).toBe(first);
    });

    it('passes the caller arguments through untouched', async () => {
      let received: Record<string, unknown> | null = null;
      const echo = def('echo', async (args) => {
        received = args;
        return {};
      });
      const { sdk, handlers } = makeSdk();
      buildMcpServer(sdk, [echo], { userId: 'u', workspaceId: 'ws' });

      await handlers.get('echo')!({ channel: '#general', text: 'hi' });

      expect(received).toEqual({ channel: '#general', text: 'hi' });
    });
  });

  describe('result wrapping', () => {
    it('wraps a handler return as MCP text content', async () => {
      const ok = def('ok', async () => ({ sent: true, id: 42 }));
      const { sdk, handlers } = makeSdk();
      buildMcpServer(sdk, [ok], { userId: 'u', workspaceId: 'ws' });

      const result = await handlers.get('ok')!({});

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ sent: true, id: 42 }) },
      ]);
    });

    // A throwing tool must not escape and kill the turn — the model should see
    // the failure as a result it can react to.
    it('turns a thrown Error into an isError result rather than rejecting', async () => {
      const boom = def('boom', async () => {
        throw new Error('slack channel not found');
      });
      const { sdk, handlers } = makeSdk();
      buildMcpServer(sdk, [boom], { userId: 'u', workspaceId: 'ws' });

      const result = await handlers.get('boom')!({});

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        error: 'slack channel not found',
      });
    });

    it('falls back to a generic message when a non-Error is thrown', async () => {
      const odd = def('odd', async () => {
        throw 'just a string';
      });
      const { sdk, handlers } = makeSdk();
      buildMcpServer(sdk, [odd], { userId: 'u', workspaceId: 'ws' });

      const result = await handlers.get('odd')!({});

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        error: 'Tool failed',
      });
    });

    it('registers every tool it is given', () => {
      const { sdk, handlers } = makeSdk();
      buildMcpServer(
        sdk,
        [
          def('one', async () => ({})),
          def('two', async () => ({})),
          def('three', async () => ({})),
        ],
        { userId: 'u', workspaceId: 'ws' },
      );

      expect([...handlers.keys()]).toEqual(['one', 'two', 'three']);
    });
  });

  describe('tool name qualification', () => {
    it('round-trips a qualified name', () => {
      const qualified = toQualifiedToolName('send_slack_message');
      expect(qualified).toBe(`mcp__${MCP_SERVER_NAME}__send_slack_message`);
      expect(stripQualifiedToolName(qualified)).toBe('send_slack_message');
    });

    it('leaves an unqualified name alone', () => {
      expect(stripQualifiedToolName('send_slack_message')).toBe(
        'send_slack_message',
      );
    });

    it('only strips the prefix at the start', () => {
      const odd = `tool__mcp__${MCP_SERVER_NAME}__x`;
      expect(stripQualifiedToolName(odd)).toBe(odd);
    });
  });
});
