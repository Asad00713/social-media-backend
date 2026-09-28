import { Logger } from '@nestjs/common';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { stampPendingAction } from './confirm';

/**
 * Running one tool, the same way for every runtime.
 *
 * The Agent SDK reaches a tool through its MCP wrapper; the Messages-API
 * runtime calls it directly. Both must produce the SAME result, because what a
 * tool returns is not just data — a confirm card is only honoured if it was
 * stamped with the tool and arguments that produced it, and an error has to
 * come back as a RESULT the model can read rather than an exception that ends
 * the turn. Two copies of that would drift the first time one was changed.
 */

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
export function outcomeOf(data: unknown): string {
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

/** What a tool produced: JSON text for the model, plus whether it failed. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/**
 * Run one tool and render its outcome for the model.
 *
 * A thrown error is caught and returned as `isError` text rather than
 * propagated: the model can read "that channel does not exist" and try
 * something else, where an exception would abandon the turn mid-answer.
 */
export async function runTool(
  def: AgentToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
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
    return { text: JSON.stringify(data), isError: false };
  } catch (err) {
    toolLogger.warn(`${def.name} failed: ${String(err)}`);
    return {
      text: JSON.stringify({
        error: err instanceof Error ? err.message : 'Tool failed',
      }),
      isError: true,
    };
  }
}
