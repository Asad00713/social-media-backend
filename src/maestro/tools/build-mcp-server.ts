import { Logger } from '@nestjs/common';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { stampPendingAction } from './confirm';

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

/**
 * Every tool call, with the arguments the MODEL chose.
 *
 * Two runs of the same question returned different answers — one of them
 * wrong — and the transcript alone could not say why: the model may have
 * passed a date range it invented, or read a correct result wrongly. Those
 * need opposite fixes, so the arguments have to be on the record before
 * anyone reasons about a cause.
 */
const toolLogger = new Logger('MaestroToolCall');

/** Enough of a result to tell "read it wrong" from "asked the wrong thing". */
function outcomeOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return typeof data;
  const payload = data as Record<string, unknown>;
  const body = (
    payload.kind === 'refs' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload
  ) as Record<string, unknown>;

  const parts: string[] = [];
  const range = body.range as Record<string, unknown> | undefined;
  if (range && typeof range.label === 'string') {
    parts.push(`range="${range.label}"`);
  }
  for (const key of [
    'total',
    'showing',
    'upcomingCount',
    'alreadyOutCount',
    'postsOutsideThisWindow',
  ]) {
    if (typeof body[key] === 'number')
      parts.push(`${key}=${String(body[key])}`);
  }
  return parts.length ? parts.join(' ') : 'ok';
}

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
        // The model's own arguments, before anything defaults them — this is
        // the line that says whether a wrong answer came from a wrong question.
        toolLogger.debug(`${def.name} args=${JSON.stringify(args)}`);
        try {
          const data = stampPendingAction(
            await def.handler(args, ctx),
            def.name,
            args,
          );
          toolLogger.debug(`${def.name} -> ${outcomeOf(data)}`);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          };
        } catch (err) {
          toolLogger.warn(`${def.name} failed: ${String(err)}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: err instanceof Error ? err.message : 'Tool failed',
                }),
              },
            ],
            isError: true,
          };
        }
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
