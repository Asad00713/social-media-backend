import { Injectable } from '@nestjs/common';
import type { AgentRuntime } from '../maestro.types';
import { ClaudeAgentSdkRuntime } from './claude-agent-sdk.runtime';
import { MessagesApiRuntime } from './messages-api.runtime';

/** Which implementation of the runtime port answers a turn. */
export const AGENT_RUNTIMES = ['sdk', 'api'] as const;
export type AgentRuntimeKind = (typeof AGENT_RUNTIMES)[number];

/**
 * The runtime a turn asks for, defaulting to the one in production.
 *
 * Both run side by side while the Messages-API adapter is brought up to the
 * Agent SDK's behaviour, so the two can be compared on the same question with
 * the same tools. `sdk` stays the default: anything that does not name a
 * runtime — the Telegram and WhatsApp bridges, an older client — keeps the
 * behaviour it has today.
 */
export function parseRuntimeKind(value: unknown): AgentRuntimeKind {
  return value === 'api' ? 'api' : 'sdk';
}

@Injectable()
export class AgentRuntimeSelector {
  constructor(
    private readonly sdkRuntime: ClaudeAgentSdkRuntime,
    private readonly apiRuntime: MessagesApiRuntime,
  ) {}

  forKind(kind: AgentRuntimeKind): AgentRuntime {
    return kind === 'api' ? this.apiRuntime : this.sdkRuntime;
  }
}
