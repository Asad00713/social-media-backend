import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  BaseLLMProvider,
  LLMMessage,
  LLMChatOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
} from './llm-provider.interface';

@Injectable()
export class ClaudeChatProvider extends BaseLLMProvider {
  private readonly logger = new Logger(ClaudeChatProvider.name);
  private readonly client: Anthropic | null = null;

  readonly name = 'claude';
  readonly models = ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

  private readonly defaultModel = 'claude-sonnet-4-5-20250929';

  constructor(private readonly configService: ConfigService) {
    super();

    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Claude chat provider initialized');
    } else {
      this.logger.warn(
        'No ANTHROPIC_API_KEY configured - Claude provider unavailable',
      );
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private ensureClient(): Anthropic {
    if (!this.client) {
      throw new Error('Anthropic API is not configured');
    }
    return this.client;
  }

  /**
   * Extract system message and convert the rest to Anthropic format.
   */
  private formatMessages(messages: LLMMessage[]): {
    system: string | undefined;
    messages: Anthropic.MessageParam[];
  } {
    let system: string | undefined;
    const formatted: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content || undefined;
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Assistant message with tool use
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        formatted.push({ role: 'assistant', content });
        continue;
      }

      if (msg.role === 'tool') {
        // Tool result message
        formatted.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || '',
              content: msg.content || '',
            },
          ],
        });
        continue;
      }

      formatted.push({
        role: msg.role,
        content: msg.content || '',
      });
    }

    return { system, messages: formatted };
  }

  private formatTools(options?: LLMChatOptions): Anthropic.Tool[] | undefined {
    if (!options?.tools?.length) return undefined;

    return options.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = this.ensureClient();
    const model = options?.model || this.defaultModel;
    const { system, messages: formatted } = this.formatMessages(messages);

    const response = await client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      system,
      messages: formatted,
      tools: this.formatTools(options),
    });

    // Extract content and tool calls from response
    let textContent = '';
    const toolCalls: LLMToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: textContent || null,
      toolCalls,
      model,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens:
              response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): AsyncGenerator<LLMStreamChunk> {
    const client = this.ensureClient();
    const model = options?.model || this.defaultModel;
    const { system, messages: formatted } = this.formatMessages(messages);

    const stream = client.messages.stream({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      system,
      messages: formatted,
      tools: this.formatTools(options),
    });

    const toolCallsMap = new Map<
      number,
      { id: string; name: string; input: string }
    >();
    let toolIndex = 0;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolCallsMap.set(toolIndex, {
            id: event.content_block.id,
            name: event.content_block.name,
            input: '',
          });
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'content', content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const existing = toolCallsMap.get(toolIndex);
          if (existing) {
            existing.input += event.delta.partial_json;
          }
        }
      }

      if (event.type === 'content_block_stop') {
        if (toolCallsMap.has(toolIndex)) {
          toolIndex++;
        }
      }

      if (event.type === 'message_stop') {
        if (toolCallsMap.size > 0) {
          const toolCalls: LLMToolCall[] = Array.from(
            toolCallsMap.values(),
          ).map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.input },
          }));
          yield { type: 'tool_calls', toolCalls };
        }
      }

      if (event.type === 'message_delta') {
        if (event.usage) {
          yield {
            type: 'done',
            usage: {
              promptTokens: 0,
              completionTokens: event.usage.output_tokens,
              totalTokens: event.usage.output_tokens,
            },
          };
        }
      }
    }
  }
}
