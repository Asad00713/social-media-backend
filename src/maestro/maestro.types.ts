/**
 * Shared types for the Maestro agent module.
 *
 * The `AgentRuntime` port + `AgentEvent` union are intentionally
 * surface-agnostic: the Claude Agent SDK is ONE adapter behind this boundary; a
 * Messages-API adapter (or any other) could implement the same contract without
 * touching the controller, service, tools, or persistence.
 */

/** Per-request tenant context threaded into every tool handler. Never global. */
export interface ToolContext {
  userId: string;
  workspaceId: string;
}

/**
 * A surface-agnostic tool definition. The runtime adapter wraps each one as the
 * concrete SDK tool. `inputSchema` is a Zod raw shape (`{}` for param-less
 * tools); typed loosely here to avoid a hard Zod dependency in Phase 1.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** One prior conversation turn, replayed from our DB (stateless persistence). */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A file the user attached to a turn (image or PDF). Stored in Cloudflare R2;
 * the runtime fetches `url` and base64-encodes it into a content block at send
 * time (the SDK's documented image/PDF path). Persisted in the user message's
 * metadata so the chat bubble can re-render it on reload.
 */
export interface MaestroAttachment {
  /** Public R2 URL of the uploaded file. */
  url: string;
  /** MIME type, e.g. "image/png" or "application/pdf". */
  mediaType: string;
  kind: 'image' | 'pdf';
  /** Original filename (shown in the chip). */
  name: string;
  /** Size in bytes. */
  size: number;
}

/** Normalized event stream the orchestrator consumes — independent of the SDK. */
export type AgentEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: 'done';
      usage: { inputTokens: number; outputTokens: number; costUsd: number };
    }
  | { type: 'error'; message: string };

/** Input to a single agent run (one user turn). */
export interface AgentRunInput {
  ctx: ToolContext;
  /** Static product knowledge / behavior. History is added by the adapter. */
  systemPrompt: string | string[];
  /** Prior turns, replayed from our DB. */
  history: ConversationTurn[];
  /** The new user message (the actual prompt). */
  userMessage: string;
  /** Files attached to this turn. When present, the adapter switches to the
   *  SDK's streaming-input mode and sends them as image/document blocks. */
  attachments?: MaestroAttachment[];
  /** Tools available this turn (bound to ctx by the adapter). */
  tools: AgentToolDefinition[];
  model: string;
  maxTurns?: number;
  /** Subprocess env (carries the resolved auth: API key vs Max subscription). */
  env?: Record<string, string | undefined>;
  abortController?: AbortController;
}

/** The runtime port. Agent SDK is one adapter; others can implement this. */
export interface AgentRuntime {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
