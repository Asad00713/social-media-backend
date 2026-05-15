import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  BaseLLMProvider,
  LLMMessage,
  LLMChatOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
} from './llm-provider.interface';

@Injectable()
export class OpenAIChatProvider extends BaseLLMProvider {
  private readonly logger = new Logger(OpenAIChatProvider.name);
  private readonly client: OpenAI | null = null;

  readonly name = 'openai';
  readonly models = ['gpt-4o', 'gpt-4o-mini'];

  private readonly defaultModel = 'gpt-4o';

  constructor(private readonly configService: ConfigService) {
    super();

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      this.logger.log('OpenAI chat provider initialized');
    } else {
      this.logger.warn('No OPENAI_API_KEY configured - OpenAI provider unavailable');
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error('OpenAI API is not configured');
    }
    return this.client;
  }

  private formatMessages(
    messages: LLMMessage[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content || '',
          tool_call_id: msg.tool_call_id || '',
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || '',
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content || '',
      };
    });
  }

  private formatTools(
    options?: LLMChatOptions,
  ): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (!options?.tools?.length) return undefined;

    return options.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
    const client = this.ensureClient();
    const model = options?.model || this.defaultModel;

    const completion = await client.chat.completions.create({
      model,
      messages: this.formatMessages(messages),
      tools: this.formatTools(options),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    });

    const choice = completion.choices[0];

    return {
      content: choice?.message?.content || null,
      toolCalls: (choice?.message?.tool_calls || [])
        .filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      model,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
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

    const stream = await client.chat.completions.create({
      model,
      messages: this.formatMessages(messages),
      tools: this.formatTools(options),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    });

    const toolCallsMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const finishReason = chunk.choices[0]?.finish_reason;

      // Stream text content
      if (delta?.content) {
        yield { type: 'content', content: delta.content };
      }

      // Accumulate tool call chunks
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallsMap.has(tc.index)) {
            toolCallsMap.set(tc.index, { id: '', name: '', arguments: '' });
          }
          const existing = toolCallsMap.get(tc.index)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        }
      }

      // Tool calls complete
      if (finishReason === 'tool_calls') {
        const toolCalls: LLMToolCall[] = Array.from(toolCallsMap.values()).map(
          (tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }),
        );
        yield { type: 'tool_calls', toolCalls };
      }

      // Stream complete — usage in final chunk
      if (finishReason === 'stop' || (chunk.usage && !delta)) {
        const usage = chunk.usage;
        yield {
          type: 'done',
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
        };
      }
    }
  }
}
