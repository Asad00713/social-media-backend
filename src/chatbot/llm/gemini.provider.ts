import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  Part,
  Tool as GeminiTool,
  FunctionDeclaration,
  FunctionCallingMode,
} from '@google/generative-ai';
import {
  BaseLLMProvider,
  LLMMessage,
  LLMChatOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
} from './llm-provider.interface';

@Injectable()
export class GeminiChatProvider extends BaseLLMProvider {
  private readonly logger = new Logger(GeminiChatProvider.name);
  private readonly genAI: GoogleGenerativeAI | null = null;

  readonly name = 'gemini';
  readonly models = ['gemini-2.0-flash', 'gemini-2.5-pro'];

  private readonly defaultModel = 'gemini-2.0-flash';

  constructor(private readonly configService: ConfigService) {
    super();

    const apiKey = this.configService.get<string>('GOOGLE_AI_API_KEY');
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.logger.log('Gemini chat provider initialized');
    } else {
      this.logger.warn(
        'No GOOGLE_AI_API_KEY configured - Gemini provider unavailable',
      );
    }
  }

  isAvailable(): boolean {
    return this.genAI !== null;
  }

  private ensureGenAI(): GoogleGenerativeAI {
    if (!this.genAI) {
      throw new Error('Google AI API is not configured');
    }
    return this.genAI;
  }

  private getModel(
    modelName: string,
    options?: LLMChatOptions,
  ): GenerativeModel {
    const genAI = this.ensureGenAI();

    const tools = this.formatTools(options);
    return genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
      ...(tools
        ? {
            tools,
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingMode.AUTO },
            },
          }
        : {}),
    });
  }

  /**
   * Convert LLMMessage[] to Gemini Content[] + system instruction.
   */
  private formatMessages(messages: LLMMessage[]): {
    systemInstruction: string | undefined;
    contents: Content[];
  } {
    let systemInstruction: string | undefined;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content || undefined;
        continue;
      }

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content || '' }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments),
              },
            });
          }
        }
        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: 'model', parts });
        continue;
      }

      if (msg.role === 'tool') {
        // Gemini expects functionResponse inside a 'user' turn
        // but we should group consecutive tool results
        const lastContent = contents[contents.length - 1];
        const functionResponse: Part = {
          functionResponse: {
            name: msg.name || 'unknown',
            response: { result: msg.content || '' },
          },
        };

        // Group with previous tool results if last content is already a function response
        if (lastContent && lastContent.role === ('function' as any)) {
          lastContent.parts.push(functionResponse);
        } else {
          contents.push({
            role: 'function' as any,
            parts: [functionResponse],
          });
        }
        continue;
      }
    }

    return { systemInstruction, contents };
  }

  private formatTools(options?: LLMChatOptions): GeminiTool[] | undefined {
    if (!options?.tools?.length) return undefined;

    const functionDeclarations: FunctionDeclaration[] = options.tools.map(
      (tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as any,
      }),
    );

    return [{ functionDeclarations }];
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const modelName = options?.model || this.defaultModel;
    const model = this.getModel(modelName, options);
    const { systemInstruction, contents } = this.formatMessages(messages);

    const result = await model.generateContent({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const response = result.response;
    const candidate = response.candidates?.[0];

    let textContent = '';
    const toolCalls: LLMToolCall[] = [];
    let toolCallIndex = 0;

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          textContent += part.text;
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: `call_${toolCallIndex++}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }
    }

    const usage = response.usageMetadata;

    return {
      content: textContent || null,
      toolCalls,
      model: modelName,
      usage: usage
        ? {
            promptTokens: usage.promptTokenCount || 0,
            completionTokens: usage.candidatesTokenCount || 0,
            totalTokens: usage.totalTokenCount || 0,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): AsyncGenerator<LLMStreamChunk> {
    const modelName = options?.model || this.defaultModel;
    const model = this.getModel(modelName, options);
    const { systemInstruction, contents } = this.formatMessages(messages);

    const result = await model.generateContentStream({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const toolCalls: LLMToolCall[] = [];
    let toolCallIndex = 0;

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;

      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          yield { type: 'content', content: part.text };
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: `call_${toolCallIndex++}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }
    }

    // Emit accumulated tool calls
    if (toolCalls.length > 0) {
      yield { type: 'tool_calls', toolCalls };
    }

    // Get usage from aggregated response
    const aggregated = await result.response;
    const usage = aggregated.usageMetadata;

    yield {
      type: 'done',
      usage: usage
        ? {
            promptTokens: usage.promptTokenCount || 0,
            completionTokens: usage.candidatesTokenCount || 0,
            totalTokens: usage.totalTokenCount || 0,
          }
        : undefined,
    };
  }
}
