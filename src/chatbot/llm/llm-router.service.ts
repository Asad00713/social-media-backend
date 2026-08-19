import { Injectable, Logger, Optional } from '@nestjs/common';
import { BaseLLMProvider, LLMChatOptions } from './llm-provider.interface';
import { GroqChatProvider } from './groq.provider';
import { ClaudeChatProvider } from './claude.provider';
import { OpenAIChatProvider } from './openai.provider';
import { GeminiChatProvider } from './gemini.provider';

/**
 * LLM Router - selects the appropriate LLM provider and model
 * based on the task type and complexity.
 *
 * v3: Supports Groq, Claude, OpenAI, and Gemini with premium gating.
 */
@Injectable()
export class LLMRouterService {
  private readonly logger = new Logger(LLMRouterService.name);
  private readonly providers = new Map<string, BaseLLMProvider>();

  constructor(
    private readonly groqProvider: GroqChatProvider,
    private readonly claudeProvider: ClaudeChatProvider,
    @Optional() private readonly openaiProvider?: OpenAIChatProvider,
    @Optional() private readonly geminiProvider?: GeminiChatProvider,
  ) {
    this.providers.set('groq', groqProvider);
    this.providers.set('claude', claudeProvider);
    if (openaiProvider?.isAvailable())
      this.providers.set('openai', openaiProvider);
    if (geminiProvider?.isAvailable())
      this.providers.set('gemini', geminiProvider);
    this.logger.log(
      `Registered LLM providers: ${Array.from(this.providers.keys()).join(', ')}`,
    );
  }

  /**
   * Get the best provider for the current request.
   * v1: Always returns Groq provider.
   */
  getProvider(options?: { preferredProvider?: string }): BaseLLMProvider {
    if (
      options?.preferredProvider &&
      this.providers.has(options.preferredProvider)
    ) {
      return this.providers.get(options.preferredProvider)!;
    }
    return this.groqProvider;
  }

  /**
   * Get the best model for the task type.
   * GPT-OSS-120B for tool calling & complex reasoning, GPT-OSS-20B for simple
   * tasks. (Groq decommissioned the llama-3.x models — 404.)
   */
  getModelForTask(
    taskType: 'simple' | 'complex' | 'tool_calling' = 'complex',
  ): string {
    switch (taskType) {
      case 'simple':
        return 'openai/gpt-oss-20b';
      case 'complex':
      case 'tool_calling':
      default:
        return 'openai/gpt-oss-120b';
    }
  }

  /**
   * Classify user intent to determine which model and tool set to use.
   * Rule-based for speed (no LLM call needed).
   */
  classifyIntent(userMessage: string): 'simple' | 'complex' | 'tool_calling' {
    const msg = userMessage.toLowerCase().trim();

    // Greetings, meta-questions, simple acknowledgments
    const simplePatterns = [
      /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|got it|bye|goodbye|good morning|good evening|gm|gn)[\s!?.]*$/,
      /^what (can you do|are you|is this)/,
      /^who are you/,
      /^how are you/,
      /^help$/,
    ];
    if (simplePatterns.some((p) => p.test(msg))) return 'simple';

    // Tool-triggering keywords
    const toolKeywords = [
      'post',
      'schedule',
      'create',
      'delete',
      'update',
      'edit',
      'channel',
      'connect',
      'disconnect',
      'navigate',
      'go to',
      'open',
      'take me',
      'search',
      'find',
      'look for',
      'show me',
      'image',
      'photo',
      'video',
      'picture',
      'media',
      'unsplash',
      'pexels',
      'canva',
      'drive',
      'onedrive',
      'dropbox',
      'google photos',
      'media library',
      'download',
      'theme',
      'dark mode',
      'light mode',
      'draft',
      'publish',
      'scheduled',
      'workspace',
      'profile',
      'my name',
      'my email',
    ];
    if (toolKeywords.some((k) => msg.includes(k))) return 'tool_calling';

    return 'complex';
  }

  /**
   * Get the best model for a provider type.
   */
  getModelForProvider(
    provider: string,
    taskType: 'simple' | 'complex' | 'tool_calling',
  ): string {
    if (provider === 'claude') {
      return taskType === 'simple'
        ? 'claude-haiku-4-5-20251001'
        : 'claude-sonnet-4-5-20250929';
    }
    if (provider === 'openai') {
      return taskType === 'simple' ? 'gpt-4o-mini' : 'gpt-4o';
    }
    if (provider === 'gemini') {
      return taskType === 'simple' ? 'gemini-2.0-flash' : 'gemini-2.5-pro';
    }
    return this.getModelForTask(taskType);
  }

  /**
   * Get all available provider names (only those with valid API keys).
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is available.
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get default chat options for the current configuration.
   */
  getDefaultOptions(): LLMChatOptions {
    return {
      model: this.getModelForTask('complex'),
      temperature: 0.7,
      maxTokens: 4096,
    };
  }
}
