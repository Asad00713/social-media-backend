import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import {
  BaseLLMProvider,
  LLMMessage,
  LLMChatOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
} from './llm-provider.interface';

@Injectable()
export class GroqChatProvider extends BaseLLMProvider {
  private readonly logger = new Logger(GroqChatProvider.name);

  /** All available Groq clients (one per API key). */
  private readonly clients: Groq[] = [];
  /** Index of the currently active client. */
  private activeClientIndex = 0;

  readonly name = 'groq';
  readonly models = [
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
  ];

  private readonly defaultModel = 'openai/gpt-oss-120b';

  constructor(private readonly configService: ConfigService) {
    super();

    // Load all available API keys
    const keys = [
      this.configService.get<string>('GROQ_API_KEY'),
      this.configService.get<string>('GROQ_API_KEY_2'),
    ].filter(Boolean) as string[];

    for (const apiKey of keys) {
      this.clients.push(new Groq({ apiKey }));
    }

    if (this.clients.length > 0) {
      this.logger.log(
        `Groq chat provider initialized with ${this.clients.length} API key(s)`,
      );
    } else {
      this.logger.warn(
        'No GROQ_API_KEY configured - chatbot will be unavailable',
      );
    }
  }

  private ensureClient(): Groq {
    if (this.clients.length === 0) {
      throw new Error('Groq API is not configured');
    }
    return this.clients[this.activeClientIndex];
  }

  /**
   * Rotate to the next API key. Returns true if a different key is available.
   */
  rotateKey(): boolean {
    if (this.clients.length <= 1) return false;
    const prev = this.activeClientIndex;
    this.activeClientIndex = (this.activeClientIndex + 1) % this.clients.length;
    this.logger.log(
      `Rotated Groq API key: ${prev + 1} → ${this.activeClientIndex + 1}`,
    );
    return true;
  }

  private formatMessages(
    messages: LLMMessage[],
  ): Groq.Chat.Completions.ChatCompletionMessageParam[] {
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
        role: msg.role,
        content: msg.content || '',
      };
    });
  }

  private formatTools(
    options?: LLMChatOptions,
  ): Groq.Chat.Completions.ChatCompletionTool[] | undefined {
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

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
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
      toolCalls: (choice?.message?.tool_calls || []).map((tc) => ({
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

  /**
   * Check if an error is a Groq tool-call generation failure (400).
   * Extracts and logs the failed_generation field for debugging.
   */
  isToolCallError(error: unknown): boolean {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error as any).status === 400
    ) {
      const msg =
        (error as any)?.error?.message || (error as any)?.message || '';
      if (
        msg.includes('Failed to call a function') ||
        msg.includes('Tool call validation failed') ||
        msg.includes('did not match schema')
      ) {
        const failedGen =
          (error as any)?.error?.failed_generation ||
          (error as any)?.failed_generation;
        if (failedGen) {
          this.logger.warn(`Groq failed_generation: ${failedGen}`);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Check if an error is a Groq rate-limit / request-too-large error (413 or 429).
   */
  isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as any).status;
      return status === 413 || status === 429;
    }
    return false;
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
    });

    // Accumulate tool calls from stream chunks
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
          if (tc.function?.arguments)
            existing.arguments += tc.function.arguments;
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

      // Stream complete
      if (finishReason === 'stop') {
        yield {
          type: 'done',
          usage: chunk.x_groq?.usage
            ? {
                promptTokens: chunk.x_groq.usage.prompt_tokens,
                completionTokens: chunk.x_groq.usage.completion_tokens,
                totalTokens: chunk.x_groq.usage.total_tokens,
              }
            : undefined,
        };
      }
    }
  }
}
