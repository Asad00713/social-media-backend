import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { GeminiChatProvider } from '../chatbot/llm/gemini.provider';
import { GroqService } from './groq.service';

/**
 * Single-shot LLM completion with Gemini as the primary provider and Groq
 * as the fallback. Not chat/tool-calling — for that, use ChatbotModule's
 * LLMRouterService. This is the low-level text-completion primitive shared
 * by AI-assist features (e.g. per-channel composer suggestions).
 */
@Injectable()
export class AiTextService {
  private readonly logger = new Logger(AiTextService.name);

  constructor(
    private readonly gemini: GeminiChatProvider,
    private readonly groq: GroqService,
  ) {}

  isReady(): boolean {
    return this.gemini.isAvailable() || this.groq.isReady();
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    if (this.gemini.isAvailable()) {
      try {
        return await this.gemini.generateText(systemPrompt, userPrompt, opts);
      } catch (err) {
        this.logger.warn(
          `Gemini failed, falling back to Groq: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (this.groq.isReady()) {
      return this.groq.completeRaw(systemPrompt, userPrompt, opts);
    }

    throw new BadRequestException('AI is not configured');
  }
}
