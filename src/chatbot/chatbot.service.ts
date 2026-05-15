import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { workspace, subscriptions } from '../drizzle/schema';
import { ConversationService } from './services/conversation.service';
import { ContextBuilderService } from './services/context-builder.service';
import { AgentService, AgentSSEEvent, MediaItem, PostPreviewData } from './services/agent.service';
import { TokenTrackingService } from './services/token-tracking.service';
import { LLMRouterService } from './llm/llm-router.service';
import { LLMMessage } from './llm/llm-provider.interface';
import type { ChatMessage } from '../drizzle/schema/chatbot.schema';

/** Provider access per plan tier. */
const PLAN_PROVIDERS: Record<string, string[]> = {
  FREE: ['groq'],
  PRO: ['groq', 'openai', 'gemini'],
  MAX: ['groq', 'openai', 'gemini', 'claude'],
};

export interface ProcessMessageOptions {
  conversationId: string;
  userId: string;
  workspaceId: string;
  message: string;
  currentRoute?: string;
  replyToMessageId?: string;
}

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly contextBuilder: ContextBuilderService,
    private readonly agentService: AgentService,
    private readonly tokenTracking: TokenTrackingService,
    private readonly llmRouter: LLMRouterService,
  ) {}

  /**
   * Process a user message and yield SSE events.
   *
   * This is the main entry point — it:
   * 1. Validates the conversation belongs to the user
   * 2. Saves the user message
   * 3. Builds context (system prompt + history)
   * 4. Runs the agent loop
   * 5. Saves the assistant response
   */
  async *processMessage(
    options: ProcessMessageOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentSSEEvent> {
    const { conversationId, userId, workspaceId, message, currentRoute, replyToMessageId } = options;

    // Validate conversation ownership
    const conversation = await this.conversationService.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    // Check token budget before processing
    const budget = await this.tokenTracking.checkBudget(workspaceId);
    if (budget.exceeded) {
      yield {
        event: 'error',
        data: {
          message: `You've used all ${budget.limit.toLocaleString()} AI tokens for this month. Upgrade your plan or purchase additional tokens to continue.`,
        },
      };
      yield { event: 'done', data: {} };
      return;
    }

    // Sanitize input against prompt injection
    const sanitizedMessage = this.sanitizeInput(message);

    // Save user message (with reply-to reference if provided)
    await this.conversationService.addMessage(
      conversationId,
      'user',
      sanitizedMessage,
      replyToMessageId ? { replyToId: replyToMessageId } : undefined,
      undefined,
      undefined,
      replyToMessageId,
    );
    const needsTitle = !conversation.title;

    // Build system prompt with user/workspace context
    const systemPrompt = await this.contextBuilder.buildSystemPrompt(
      userId,
      workspaceId,
      currentRoute,
    );

    // Load conversation history
    const recentMessages = await this.conversationService.getRecentMessages(
      conversationId,
    );
    const historyMessages = this.contextBuilder.buildMessageHistory(recentMessages);

    // If the user is replying to a specific message, prepend the quoted context
    // directly into the user's message so the LLM can't miss it
    if (replyToMessageId) {
      const quotedMsg = await this.conversationService.findMessageById(replyToMessageId);
      if (quotedMsg && historyMessages.length > 0) {
        const lastMsg = historyMessages[historyMessages.length - 1];
        if (lastMsg.role === 'user') {
          lastMsg.content = this.buildReplyToUserMessage(quotedMsg, lastMsg.content || '');
        }
      }
    }

    // Build media summary from conversation history so the AI knows what it already returned
    const mediaSummary = this.contextBuilder.buildMediaSummary(recentMessages);

    // Construct full message array for the LLM
    const llmMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt + mediaSummary },
      ...historyMessages,
    ];

    // Resolve workspace AI provider preference + plan gating
    const preferredProvider = await this.resolveProvider(workspaceId);

    // Run the agent loop and collect results for persistence
    let assistantContent = '';
    let followups: string[] = [];
    let actions: Array<{ type: string; payload: Record<string, any> }> = [];
    let thinkingSteps: string[] = [];
    let toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = [];
    let media: MediaItem[] = [];
    let postPreviews: PostPreviewData[] = [];
    let saved = false;

    try {
      for await (const event of this.agentService.run(
        llmMessages,
        { userId, workspaceId },
        signal,
        { preferredProvider },
      )) {
        // Collect data for persistence
        if (event.event === 'message_complete') {
          assistantContent = event.data.content;
        }
        if (event.event === 'followups') {
          followups = event.data.suggestions;
        }
        if (event.event === 'actions') {
          actions = event.data.actions;
        }
        if (event.event === 'thinking_step') {
          thinkingSteps.push(event.data.step);
        }
        if (event.event === 'media') {
          media.push(...event.data.items);
        }
        if (event.event === 'post_preview') {
          postPreviews.push(...event.data.previews);
        }

        // Save to DB before yielding `done`, so we can send the real message ID
        if (event.event === 'done' && assistantContent) {
          try {
            const savedMsg = await this.conversationService.addMessage(
              conversationId,
              'assistant',
              assistantContent,
              {
                followups,
                actions,
                thinkingSteps,
                toolCalls,
                ...(media.length > 0 && { media }),
                ...(postPreviews.length > 0 && { postPreviews }),
              },
              undefined,
              undefined,
              replyToMessageId,
            );
            saved = true;
            yield { event: 'message_saved', data: { messageId: savedMsg.id } };
          } catch (error) {
            this.logger.error(`Failed to save assistant message: ${error}`);
          }

          // Record token usage (non-blocking)
          const estimatedTokens = Math.ceil((assistantContent.length + message.length) / 4);
          this.tokenTracking
            .recordUsage(workspaceId, userId, estimatedTokens, 'chat', {
              inputSummary: message.substring(0, 200),
              outputLength: assistantContent.length,
            })
            .catch((err) => this.logger.warn(`Token recording failed: ${err}`));

          // Generate AI title for first message (after we have the response for context)
          if (needsTitle) {
            try {
              const title = await this.generateConversationTitle(
                message,
                assistantContent,
              );
              await this.conversationService.updateTitle(conversationId, title);
              yield { event: 'title_generated', data: { title } };
            } catch (error) {
              this.logger.warn(`Failed to generate AI title: ${error}`);
              // Fallback to truncated message
              await this.conversationService.updateTitle(
                conversationId,
                message.length > 50 ? message.substring(0, 47) + '...' : message,
              );
            }
          }
        }

        // Forward all events to the client
        yield event;
      }
    } finally {
      // Fallback save — runs when client disconnects mid-stream (generator.return()).
      // The `done` event save above handles the normal flow.
      if (assistantContent && !saved) {
        try {
          await this.conversationService.addMessage(
            conversationId,
            'assistant',
            assistantContent,
            {
              followups,
              actions,
              thinkingSteps,
              toolCalls,
              ...(media.length > 0 && { media }),
              ...(postPreviews.length > 0 && { postPreviews }),
            },
            undefined,
            undefined,
            replyToMessageId,
          );
        } catch (error) {
          this.logger.error(`Failed to save assistant message (fallback): ${error}`);
        }

        // Fallback title generation
        if (needsTitle) {
          await this.conversationService.updateTitle(
            conversationId,
            message.length > 50 ? message.substring(0, 47) + '...' : message,
          );
        }
      }
    }
  }

  /**
   * Create a new conversation.
   */
  async createConversation(userId: string, workspaceId: string, title?: string) {
    return this.conversationService.create(userId, workspaceId, title);
  }

  /**
   * Get the workspace's preferred AI provider.
   */
  async getProviderPreference(workspaceId: string): Promise<string | null> {
    const [ws] = await db
      .select({ preferredAiProvider: workspace.preferredAiProvider })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return ws?.preferredAiProvider || null;
  }

  /**
   * Set the workspace's preferred AI provider.
   */
  async setProviderPreference(
    workspaceId: string,
    userId: string,
    provider: string | null,
  ): Promise<void> {
    const [ws] = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (!ws) throw new NotFoundException('Workspace not found');
    if (ws.ownerId !== userId) throw new NotFoundException('Workspace not found');

    await db
      .update(workspace)
      .set({ preferredAiProvider: provider, updatedAt: new Date() })
      .where(eq(workspace.id, workspaceId));
  }

  /**
   * List conversations for a user in a workspace.
   */
  async listConversations(
    userId: string,
    workspaceId: string,
    limit?: number,
    offset?: number,
  ) {
    return this.conversationService.list(userId, workspaceId, limit, offset);
  }

  /**
   * Get a single conversation with its messages.
   */
  async getConversation(conversationId: string, userId: string) {
    const conversation = await this.conversationService.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    const messages = await this.conversationService.getMessages(conversationId);
    return { ...conversation, messages };
  }

  /**
   * Delete a conversation.
   */
  async deleteConversation(conversationId: string, userId: string) {
    return this.conversationService.delete(conversationId, userId);
  }

  /**
   * Get messages for a conversation.
   */
  async getMessages(
    conversationId: string,
    userId: string,
    limit?: number,
    offset?: number,
  ) {
    const conversation = await this.conversationService.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    return this.conversationService.getMessages(conversationId, limit, offset);
  }

  /**
   * Submit feedback on an assistant message.
   */
  async submitFeedback(
    conversationId: string,
    messageId: string,
    userId: string,
    rating: 'good' | 'bad',
    comment?: string,
  ) {
    const conversation = await this.conversationService.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    return this.conversationService.setFeedback(messageId, rating, comment);
  }

  /**
   * Search conversations by message content or title.
   */
  async searchConversations(userId: string, workspaceId: string, query: string, limit?: number) {
    return this.conversationService.search(userId, workspaceId, query, limit);
  }

  /**
   * Toggle pin status on a conversation.
   */
  async togglePin(conversationId: string, userId: string) {
    return this.conversationService.togglePin(conversationId, userId);
  }

  /**
   * Export a conversation.
   */
  async exportConversation(
    conversationId: string,
    userId: string,
    format: 'json' | 'markdown' = 'json',
  ) {
    return this.conversationService.exportConversation(conversationId, userId, format);
  }

  /**
   * Share a conversation with workspace members.
   */
  async shareConversation(conversationId: string, userId: string) {
    return this.conversationService.shareConversation(conversationId, userId);
  }

  /**
   * Unshare a conversation.
   */
  async unshareConversation(conversationId: string, userId: string) {
    return this.conversationService.unshareConversation(conversationId, userId);
  }

  /**
   * List shared conversations in a workspace.
   */
  async listSharedConversations(workspaceId: string, limit?: number, offset?: number) {
    return this.conversationService.listShared(workspaceId, limit, offset);
  }

  /**
   * Get a shared conversation (read-only access for workspace members).
   */
  async getSharedConversation(conversationId: string, workspaceId: string) {
    const conversation = await this.conversationService.findSharedById(
      conversationId,
      workspaceId,
    );
    const messages = await this.conversationService.getMessages(conversationId);
    return { ...conversation, messages };
  }

  /**
   * Regenerate the last assistant response.
   *
   * Deletes the last assistant message and re-runs the agent loop
   * using the same user message that originally triggered it.
   * Does NOT create a new user message — reuses the existing one.
   */
  async *regenerateResponse(
    conversationId: string,
    userId: string,
    workspaceId: string,
    currentRoute?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentSSEEvent> {
    const conversation = await this.conversationService.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    // Delete last assistant message and get the triggering user message
    const lastUserMsg =
      await this.conversationService.deleteLastAssistantMessage(conversationId);

    if (!lastUserMsg) {
      throw new NotFoundException('No user message found to regenerate from');
    }

    // Build context fresh (same as processMessage but skip saving user message)
    const systemPrompt = await this.contextBuilder.buildSystemPrompt(
      userId,
      workspaceId,
      currentRoute,
    );

    const recentMessages = await this.conversationService.getRecentMessages(
      conversationId,
    );
    const historyMessages = this.contextBuilder.buildMessageHistory(recentMessages);

    const mediaSummary = this.contextBuilder.buildMediaSummary(recentMessages);

    const llmMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt + mediaSummary },
      ...historyMessages,
    ];

    // Run agent loop and collect results
    let assistantContent = '';
    let followups: string[] = [];
    let actions: Array<{ type: string; payload: Record<string, any> }> = [];
    let thinkingSteps: string[] = [];
    let toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = [];
    let media: MediaItem[] = [];
    let postPreviews: PostPreviewData[] = [];
    let saved = false;

    try {
      for await (const event of this.agentService.run(
        llmMessages,
        { userId, workspaceId },
        signal,
      )) {
        if (event.event === 'message_complete') {
          assistantContent = event.data.content;
        }
        if (event.event === 'followups') {
          followups = event.data.suggestions;
        }
        if (event.event === 'actions') {
          actions = event.data.actions;
        }
        if (event.event === 'thinking_step') {
          thinkingSteps.push(event.data.step);
        }
        if (event.event === 'media') {
          media.push(...event.data.items);
        }
        if (event.event === 'post_preview') {
          postPreviews.push(...event.data.previews);
        }

        // Save to DB before yielding `done`, so we can send the real message ID
        if (event.event === 'done' && assistantContent) {
          try {
            const savedMsg = await this.conversationService.addMessage(
              conversationId,
              'assistant',
              assistantContent,
              {
                followups,
                actions,
                thinkingSteps,
                toolCalls,
                regenerated: true,
                ...(media.length > 0 && { media }),
                ...(postPreviews.length > 0 && { postPreviews }),
              },
            );
            saved = true;
            yield { event: 'message_saved', data: { messageId: savedMsg.id } };
          } catch (error) {
            this.logger.error(`Failed to save regenerated message: ${error}`);
          }
        }

        yield event;
      }
    } finally {
      if (assistantContent && !saved) {
        try {
          await this.conversationService.addMessage(
            conversationId,
            'assistant',
            assistantContent,
            {
              followups,
              actions,
              thinkingSteps,
              toolCalls,
              regenerated: true,
              ...(media.length > 0 && { media }),
              ...(postPreviews.length > 0 && { postPreviews }),
            },
          );
        } catch (error) {
          this.logger.error(`Failed to save regenerated message (fallback): ${error}`);
        }
      }
    }
  }

  /**
   * Build an augmented user message that embeds the quoted reply-to context
   * directly inside the user text. This is far more reliable than a separate
   * system message because the LLM always reads the user message.
   */
  private buildReplyToUserMessage(
    quotedMsg: ChatMessage,
    userText: string,
  ): string {
    const role =
      quotedMsg.role === 'assistant' ? 'your earlier response' : 'my earlier message';
    const meta = quotedMsg.metadata as Record<string, any> | null;

    const parts: string[] = [
      `[I'm replying to ${role} below. Answer about THIS message only, not the latest one.`,
      `- If I'm asking ABOUT the message → text summary only, do NOT re-search or re-display media.`,
      `- If I'm asking FOR the content → return from quoted data below, do NOT re-search.`,
      `- IMPORTANT: When I refer to images/videos by number ("1st", "2nd", "third image", etc.), use the POSITION number from the media list below. IGNORE any labels in alt text like "Warrior 1" — only the POSITION determines order.]`,
      ``,
      `> Quoted message (text only):`,
      `> ${(quotedMsg.content || '').substring(0, 1200).replace(/\n/g, '\n> ')}`,
    ];

    // Include numbered media data with clear positional labels
    if (meta?.media?.length) {
      const mediaDetails = meta.media
        .map(
          (m: any, i: number) =>
            `>   POSITION ${i + 1}: url=${m.url}${m.thumbnailUrl ? ` | thumb=${m.thumbnailUrl}` : ''} | ${m.source}${m.width ? ` | ${m.width}x${m.height}` : ''}${m.photographer ? ` | by ${m.photographer}` : ''}`,
        )
        .join('\n');
      parts.push(
        `>`,
        `> Media in this message (${meta.media.length} items). When user says "1st/first" = POSITION 1, "2nd/second" = POSITION 2, "3rd/third" = POSITION 3, etc:`,
        mediaDetails,
      );
    }

    parts.push(``, userText);

    return parts.join('\n');
  }

  /**
   * Resolve the preferred LLM provider for a workspace, gated by plan tier.
   */
  private async resolveProvider(workspaceId: string): Promise<string | undefined> {
    try {
      // Get workspace preferred provider
      const [ws] = await db
        .select({ preferredAiProvider: workspace.preferredAiProvider })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .limit(1);

      const preferred = ws?.preferredAiProvider;
      if (!preferred) return undefined; // use system default

      // Check plan-based access
      const [sub] = await db
        .select({ planCode: subscriptions.planCode })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.workspaceId, workspaceId),
            eq(subscriptions.status, 'active'),
          ),
        )
        .limit(1);

      const planCode = sub?.planCode || 'FREE';
      const allowed = PLAN_PROVIDERS[planCode] || PLAN_PROVIDERS.FREE;

      if (!allowed.includes(preferred)) {
        this.logger.warn(
          `Provider "${preferred}" not allowed for ${planCode} plan, falling back to groq`,
        );
        return undefined;
      }

      // Ensure the provider is actually configured
      if (!this.llmRouter.hasProvider(preferred)) {
        return undefined;
      }

      return preferred;
    } catch (error) {
      this.logger.warn(`Failed to resolve provider preference: ${error}`);
      return undefined;
    }
  }

  /**
   * Sanitize user input to protect against prompt injection attacks.
   * Strips common injection patterns and truncates excessively long messages.
   */
  private sanitizeInput(message: string): string {
    let sanitized = message;

    const injectionPatterns = [
      /\[system\]/gi,
      /\[INST\]/gi,
      /<<SYS>>/gi,
      /<\|im_start\|>system/gi,
      /ignore (?:all )?(?:previous|above) (?:instructions|prompts)/gi,
      /you are now (?:a |an )?(?:different|new)/gi,
      /new instructions:/gi,
      /system prompt override/gi,
      /disregard (?:all )?(?:previous|prior|above)/gi,
    ];

    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, '[filtered]');
    }

    // Truncate excessively long messages to prevent token abuse
    if (sanitized.length > 10000) {
      sanitized = sanitized.substring(0, 10000) + '... [truncated]';
    }

    return sanitized;
  }

  /**
   * Generate a concise, descriptive conversation title using the fast LLM model.
   * Uses both the user message and AI response for better context.
   */
  private async generateConversationTitle(
    userMessage: string,
    assistantResponse: string,
  ): Promise<string> {
    const provider = this.llmRouter.getProvider();
    const response = await provider.chat(
      [
        {
          role: 'system',
          content: `Generate a short conversation title (2-6 words) for a social media management chat.

Rules:
- Be descriptive but concise (max 50 characters)
- Capture the topic/intent, not the exact words
- Use title case
- No quotes, no punctuation at the end
- For greetings (hi, hello, hey) → use something like "Getting Started" or "New Chat"
- For questions → summarize the topic (e.g. "Scheduled Posts Overview")
- For actions → describe the action (e.g. "Creating Twitter Post")

Return ONLY the title text. Nothing else.`,
        },
        {
          role: 'user',
          content: `User: "${userMessage.substring(0, 200)}"\nAssistant: "${assistantResponse.substring(0, 200)}"`,
        },
      ],
      {
        model: this.llmRouter.getModelForTask('simple'),
        temperature: 0.3,
        maxTokens: 30,
      },
    );

    const title = (response.content || '')
      .trim()
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .substring(0, 100);

    return title || 'New Conversation';
  }
}
