import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { runTool } from './run-tool';

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

/** Tools are exposed to the model as `mcp__maestro__<tool>`. */
export const MCP_SERVER_NAME = 'maestro';

/**
 * Build a fresh in-process MCP server bound to ONE request's tenant context.
 * Each tool handler closes over `ctx` — never global — so every chat turn is
 * scoped to its authenticated user/workspace. Tool results are wrapped into the
 * MCP `CallToolResult` text shape; thrown errors become `isError` results.
 *
 * A confirm card returned by an outward tool is stamped here with the tool that
 * produced it and the arguments it was called with. This is the one place both
 * are in hand, so a new outward tool gets it for free — where stamping at each
 * `confirmCard(...)` call site would be eleven chances to forget.
 */
export function buildMcpServer(
  sdk: AgentSdk,
  tools: AgentToolDefinition[],
  ctx: ToolContext,
) {
  const sdkTools = tools.map((def) =>
    sdk.tool(
      def.name,
      def.description,
      def.inputSchema as any,
      async (args: Record<string, unknown>) => {
        // Shared with the Messages-API runtime: both must stamp confirm cards
        // and turn a throw into a readable result the same way.
        const outcome = await runTool(def, args, ctx);
        return {
          content: [{ type: 'text' as const, text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        };
      },
    ),
  );

  return sdk.createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: sdkTools,
  });
}

export function toQualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export function stripQualifiedToolName(qualified: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return qualified.startsWith(prefix)
    ? qualified.slice(prefix.length)
    : qualified;
}
