import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntime,
  AgentToolDefinition,
} from '../maestro.types';
import { runTool } from '../tools/run-tool';

/**
 * Messages-API adapter for the `AgentRuntime` port.
 *
 * The Agent SDK runs Maestro by spawning a `claude` binary per turn; this one
 * talks to the Messages API over HTTP from inside this process. Same port, same
 * `AgentEvent` stream, same tools — so the panel cannot tell them apart, which
 * is the point: the two run side by side until this one is proven equal.
 *
 * What the SDK gave us for free and is written out by hand here:
 *   - the agentic loop (call tools, feed results back, ask again)
 *   - assembling streamed deltas into the assistant turn that gets replayed
 *   - a cost figure (the API reports tokens; the SDK reported dollars)
 */

/**
 * Extended thinking, on — the SDK enables it, so leaving it off here would
 * make the two tabs answer differently on exactly the hard questions the
 * comparison is meant to settle. Thinking tokens are billed like output.
 */
const THINKING_BUDGET_TOKENS = 4000;

/**
 * Room for the answer plus the thinking that precedes it. Must exceed the
 * thinking budget or the API rejects the request.
 */
const MAX_OUTPUT_TOKENS = 16000;

/** Per-million-token prices, for the dollar figure the SDK used to hand us. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.8, output: 4 },
};

/** Charge by model family, so a dated snapshot id still prices correctly. */
function priceFor(model: string): { input: number; output: number } {
  const hit = Object.keys(PRICING).find((prefix) => model.startsWith(prefix));
  if (hit) return PRICING[hit];
  if (model.includes('opus')) return PRICING['claude-opus-4'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4'];
  return PRICING['claude-sonnet-4'];
}

function costUsd(model: string, inputTokens: number, outputTokens: number) {
  const p = priceFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * A tool's Zod raw shape, as the JSON Schema the Messages API expects.
 *
 * Tools are authored as `{ field: z.string()… }` for the SDK, which does this
 * conversion internally. `z.object` wraps the shape so descriptions, optionals
 * and enums all survive — the model reads those, so losing them would quietly
 * make it worse at choosing arguments.
 */
function toInputSchema(tool: AgentToolDefinition): Anthropic.Tool.InputSchema {
  const shape = tool.inputSchema as z.ZodRawShape;
  const schema = z.toJSONSchema(z.object(shape), { io: 'input' });
  return schema as Anthropic.Tool.InputSchema;
}

@Injectable()
export class MessagesApiRuntime implements AgentRuntime {
  private readonly logger = new Logger(MessagesApiRuntime.name);

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const apiKey = input.env?.ANTHROPIC_API_KEY;
    if (!apiKey) {
      yield { type: 'error', message: 'Maestro is not configured.' };
      return;
    }

    const client = new Anthropic({ apiKey });
    const toolsByName = new Map(input.tools.map((t) => [t.name, t]));
    const tools: Anthropic.Tool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toInputSchema(t),
    }));

    let messages: Anthropic.MessageParam[];
    try {
      messages = await this.buildMessages(input);
    } catch (err) {
      this.logger.error(`Failed to load attachments: ${err}`);
      yield {
        type: 'error',
        message:
          "I couldn't read one of your attached files. Please re-upload and try again.",
      };
      return;
    }

    // Usage accumulates across the loop: one user turn can be several API
    // calls, and the user is billed for the turn, not for each round trip.
    let inputTokens = 0;
    let outputTokens = 0;
    const maxTurns = input.maxTurns ?? 8;

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const stream = client.messages.stream(
          {
            model: input.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: this.systemBlocks(input),
            messages,
            tools,
            thinking: {
              type: 'enabled',
              budget_tokens: THINKING_BUDGET_TOKENS,
            },
          },
          { signal: input.abortController?.signal },
        );

        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: delta.thinking };
          }
        }

        const reply = await stream.finalMessage();
        inputTokens += reply.usage.input_tokens;
        outputTokens += reply.usage.output_tokens;

        const toolUses = reply.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        if (toolUses.length === 0) {
          yield {
            type: 'done',
            usage: {
              inputTokens,
              outputTokens,
              costUsd: costUsd(input.model, inputTokens, outputTokens),
            },
          };
          return;
        }

        // The assistant turn goes back verbatim — thinking blocks included.
        // The API rejects a tool result whose preceding thinking block was
        // dropped or altered, because it verifies the block's signature.
        messages.push({ role: 'assistant', content: reply.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          yield {
            type: 'tool_call',
            id: use.id,
            name: use.name,
            input: use.input,
          };

          const def = toolsByName.get(use.name);
          const outcome = def
            ? await runTool(
                def,
                use.input as Record<string, unknown>,
                input.ctx,
              )
            : {
                text: JSON.stringify({ error: `Unknown tool ${use.name}` }),
                isError: true,
              };

          yield {
            type: 'tool_result',
            id: use.id,
            name: use.name,
            output: outcome.text,
            isError: outcome.isError,
          };

          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: outcome.text,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }

        messages.push({ role: 'user', content: results });
      }

      // Ran out of turns with tools still pending. Report what it cost rather
      // than throwing away a turn the user has already been charged for.
      this.logger.warn(`Hit maxTurns (${maxTurns}) without a final answer`);
      yield {
        type: 'done',
        usage: {
          inputTokens,
          outputTokens,
          costUsd: costUsd(input.model, inputTokens, outputTokens),
        },
      };
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
   * System prompt as content blocks.
   *
   * An array `systemPrompt` is kept as separate blocks rather than joined: the
   * static product knowledge is the same on every turn, so keeping it in its
   * own block leaves it cacheable later without reshaping this.
   */
  private systemBlocks(input: AgentRunInput): Anthropic.TextBlockParam[] {
    const parts = Array.isArray(input.systemPrompt)
      ? input.systemPrompt
      : [input.systemPrompt];
    return parts
      .filter((text) => text && text.trim())
      .map((text) => ({ type: 'text' as const, text }));
  }

  /**
   * Prior turns, then this one.
   *
   * History is replayed as real `messages` rather than pasted into the system
   * prompt the way the SDK adapter has to. This is the more faithful shape —
   * the model sees who said what — and it is free here because the Messages API
   * takes the whole transcript on every call anyway.
   */
  private async buildMessages(
    input: AgentRunInput,
  ): Promise<Anthropic.MessageParam[]> {
    const messages: Anthropic.MessageParam[] = input.history
      .filter((turn) => turn.content && turn.content.trim())
      .map((turn) => ({ role: turn.role, content: turn.content }));

    const content: Anthropic.ContentBlockParam[] = [];
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
          source: {
            type: 'base64',
            media_type: att.mediaType as 'image/png',
            data,
          },
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

    // Never send an empty content array.
    if (content.length === 0) {
      content.push({ type: 'text', text: input.userMessage || '' });
    }

    messages.push({ role: 'user', content });
    return messages;
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
}
