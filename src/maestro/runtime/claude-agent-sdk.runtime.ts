import { Injectable, Logger } from '@nestjs/common';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntime,
} from '../maestro.types';
import {
  buildMcpServer,
  MCP_SERVER_NAME,
  toQualifiedToolName,
  stripQualifiedToolName,
} from '../tools/build-mcp-server';

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkPromise: Promise<AgentSdk> | null = null;

/** How the SDK is reached. Swappable for tests — see below. */
let loadSdkImpl: () => Promise<AgentSdk> = () =>
  import('@anthropic-ai/claude-agent-sdk');

/**
 * Lazy ESM import. The Agent SDK is ESM-only (`"type": "module"`); NestJS
 * compiles to CommonJS, so a static `import` would emit a `require()` and crash
 * at runtime. With `module: nodenext`, TypeScript preserves this dynamic
 * `import()` as a real runtime import. Cached after first load.
 */
function loadSdk(): Promise<AgentSdk> {
  if (!sdkPromise) {
    sdkPromise = loadSdkImpl();
  }
  return sdkPromise;
}

/**
 * Swap the SDK loader. Tests only.
 *
 * A dynamic `import()` cannot be intercepted by `jest.mock` without
 * `--experimental-vm-modules`, which is why this adapter had no tests at all —
 * and why a `tool_result` that carried no tool name went unnoticed until it
 * showed up as a step timeline that never stopped spinning. A seam here is
 * cheaper than that.
 *
 * Pass `null` to restore the real loader.
 */
export function __setSdkLoaderForTests(
  loader: (() => Promise<AgentSdk>) | null,
): void {
  sdkPromise = null;
  loadSdkImpl = loader ?? (() => import('@anthropic-ai/claude-agent-sdk'));
}

/**
 * Claude Agent SDK adapter for the `AgentRuntime` port. Translates SDK messages
 * into the normalized `AgentEvent` stream. Built-in FS/Bash/Web tools are
 * disabled (`tools: []`) and host `~/.claude` settings are ignored
 * (`settingSources: []`) so only our in-process `maestro` MCP tools are callable.
 */
@Injectable()
export class ClaudeAgentSdkRuntime implements AgentRuntime {
  private readonly logger = new Logger(ClaudeAgentSdkRuntime.name);

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    let sdk: AgentSdk;
    try {
      sdk = await loadSdk();
    } catch (err) {
      this.logger.error(`Failed to load Agent SDK: ${err}`);
      yield { type: 'error', message: 'Agent runtime unavailable' };
      return;
    }

    const mcpServer = buildMcpServer(sdk, input.tools, input.ctx);
    const allowedTools = input.tools.map((t) => toQualifiedToolName(t.name));

    // With attachments we must use the SDK's streaming-input mode (an async
    // iterable of user messages) to send image/document content blocks — the
    // single-string `prompt` form supports text only. No attachments → keep the
    // plain string form so the common text path is unchanged.
    type QueryPrompt = Parameters<typeof sdk.query>[0]['prompt'];
    let prompt: QueryPrompt = input.userMessage;
    if (input.attachments && input.attachments.length > 0) {
      try {
        prompt = (await this.buildMultimodalPrompt(input)) as QueryPrompt;
      } catch (err) {
        this.logger.error(`Failed to load attachments: ${err}`);
        yield {
          type: 'error',
          message:
            "I couldn't read one of your attached files. Please re-upload and try again.",
        };
        return;
      }
    }

    const conversation = sdk.query({
      prompt,
      options: {
        model: input.model,
        maxTurns: input.maxTurns ?? 8,
        tools: [], // disable ALL built-in FS/Bash/Web tools
        settingSources: [], // ignore host ~/.claude config (no dev MCP leakage)
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        allowedTools,
        canUseTool: (toolName, toolInput) =>
          Promise.resolve(
            allowedTools.includes(toolName)
              ? { behavior: 'allow' as const, updatedInput: toolInput }
              : {
                  behavior: 'deny' as const,
                  message: `Tool ${toolName} is not permitted.`,
                },
          ),
        includePartialMessages: true,
        systemPrompt: this.composeSystemPrompt(input),
        permissionMode: 'default',
        abortController: input.abortController,
        env: input.env,
      },
    });

    // Which tool each call id belongs to.
    //
    // Anthropic's `tool_result` block carries only a `tool_use_id` — the name
    // lives on the `tool_use` block that opened the call. Without this the
    // result went out with an empty name, so a consumer could not tell WHICH
    // tool had finished: the panel's timeline left every step spinning
    // because nothing ever matched.
    const toolNameById = new Map<string, string>();

    try {
      for await (const message of conversation) {
        switch (message.type) {
          case 'stream_event': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw stream event union
            const ev = message.event as any;
            if (ev?.type === 'content_block_delta') {
              const delta = ev.delta;
              if (delta?.type === 'text_delta') {
                yield { type: 'text_delta', text: delta.text };
              } else if (delta?.type === 'thinking_delta') {
                yield { type: 'thinking_delta', text: delta.thinking };
              }
            }
            break;
          }
          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                const name = stripQualifiedToolName(block.name);
                toolNameById.set(block.id, name);
                yield {
                  type: 'tool_call',
                  id: block.id,
                  name,
                  input: block.input,
                };
              }
            }
            break;
          }
          case 'user': {
            const content = message.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool_result block
                const b = block as any;
                if (b?.type === 'tool_result') {
                  const id = String(b.tool_use_id ?? '');
                  yield {
                    type: 'tool_result',
                    id,
                    // Resolved from the call that opened it — the result block
                    // itself has no name. Deleted as it is read: a call id is
                    // used once, and a turn with many tool calls would
                    // otherwise grow a map it never releases.
                    name: toolNameById.get(id) ?? '',
                    output: b.content,
                    isError: Boolean(b.is_error),
                  };
                  toolNameById.delete(id);
                }
              }
            }
            break;
          }
          case 'result': {
            if (message.subtype === 'success') {
              yield {
                type: 'done',
                usage: {
                  inputTokens: message.usage?.input_tokens ?? 0,
                  outputTokens: message.usage?.output_tokens ?? 0,
                  costUsd: message.total_cost_usd ?? 0,
                },
              };
            } else {
              yield { type: 'error', message: `Agent ended: ${message.subtype}` };
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      if (input.abortController?.signal.aborted) return;
      this.logger.error(`Agent run error: ${err}`);
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'Agent run failed',
      };
    }
  }

  /**
   * Build the SDK streaming-input prompt for a turn that has attachments. All
   * files are fetched + base64-encoded UP FRONT (so a fetch failure surfaces to
   * the caller as a clean error before the query starts), then a one-shot async
   * generator yields a single user message whose content is the text plus one
   * image/document block per attachment.
   */
  private async buildMultimodalPrompt(input: AgentRunInput) {
    const content: Array<Record<string, unknown>> = [];
    if (input.userMessage && input.userMessage.trim()) {
      content.push({ type: 'text', text: input.userMessage });
    }
    for (const att of input.attachments ?? []) {
      const data = await this.fetchBase64(att.url);
      if (att.kind === 'pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        });
      } else {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: att.mediaType, data },
        });
      }
    }
    // The model SEES the images/PDFs (above) but not their URLs. Surface the
    // URLs as a text note so it can FORWARD an attachment to a send/post tool
    // when asked (e.g. "post the image I attached to #general").
    const atts = input.attachments ?? [];
    if (atts.length > 0) {
      const list = atts
        .map((a, i) => `${i + 1}. ${a.name} (${a.kind}) — ${a.url}`)
        .join('\n');
      content.push({
        type: 'text',
        text: `[Attached files — for TOOL USE ONLY; never paste these URLs in your reply. If asked to send/post an attached file, pass its URL to the relevant tool:\n${list}]`,
      });
    }
    // Never yield an empty content array.
    if (content.length === 0) {
      content.push({ type: 'text', text: input.userMessage || '' });
    }
    async function* once() {
      yield { type: 'user' as const, message: { role: 'user' as const, content } };
    }
    return once();
  }

  /** Fetch a (public R2) URL and return its bytes as base64. */
  private async fetchBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`attachment fetch failed: ${res.status} ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  }

  /**
   * Static system prompt + replayed history (stateless DB-replay). The Agent SDK
   * owns the live transcript within one query(); to give it memory across
   * separate HTTP turns without SDK session files, we inject prior turns as a
   * context block. Swappable later for a DB-backed SessionStore.
   */
  private composeSystemPrompt(input: AgentRunInput): string | string[] {
    const base = Array.isArray(input.systemPrompt)
      ? input.systemPrompt
      : [input.systemPrompt];
    if (input.history.length === 0) return base;

    const transcript = input.history
      .map((t) => `${t.role === 'user' ? 'User' : 'Maestro'}: ${t.content}`)
      .join('\n');
    return [...base, `## Conversation so far\n${transcript}`];
  }
}
