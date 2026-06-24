import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChatbotRateLimitGuard } from './guards/chatbot-rate-limit.guard';
import { ChatbotService } from './chatbot.service';
import { TokenTrackingService } from './services/token-tracking.service';
import { LLMRouterService } from './llm/llm-router.service';
import { ClaudeChatProvider } from './llm/claude.provider';
import { SendMessageDto } from './dto/send-message.dto';
import {
  CreateConversationDto,
  ConversationQueryDto,
  MessageQueryDto,
  MessageFeedbackDto,
  UsageQueryDto,
  SearchConversationsDto,
} from './dto/conversation.dto';

@Controller('chatbot')
export class ChatbotController {
  private readonly logger = new Logger(ChatbotController.name);

  constructor(
    private readonly chatbotService: ChatbotService,
    private readonly tokenTracking: TokenTrackingService,
    private readonly llmRouter: LLMRouterService,
    private readonly claudeProvider: ClaudeChatProvider,
  ) {}

  // ==========================================================================
  // Test Endpoint (no auth required)
  // ==========================================================================

  /**
   * Test the Claude API connection.
   * GET /chatbot/test-claude?message=Hello
   */
  @Get('test-claude')
  async testClaude(@Query('message') message?: string) {
    try {
      const response = await this.claudeProvider.chat(
        [
          {
            role: 'user',
            content:
              message ||
              'Say "Hello! Claude API is working." in one short sentence.',
          },
        ],
        {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 100,
          temperature: 0.5,
        },
      );

      return {
        success: true,
        provider: 'claude',
        model: response.model,
        response: response.content,
        usage: response.usage,
      };
    } catch (error) {
      return {
        success: false,
        provider: 'claude',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ==========================================================================
  // Conversations
  // ==========================================================================

  /**
   * Create a new conversation.
   */
  @Post('conversations')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateConversationDto,
  ) {
    const conversation = await this.chatbotService.createConversation(
      user.userId,
      dto.workspaceId,
      dto.title,
    );

    return { conversation };
  }

  /**
   * List conversations for the current user in a workspace.
   */
  @Get('conversations')
  @UseGuards(JwtAuthGuard)
  async listConversations(
    @CurrentUser() user: { userId: string; email: string },
    @Query() query: ConversationQueryDto,
  ) {
    const conversations = await this.chatbotService.listConversations(
      user.userId,
      query.workspaceId,
      query.limit,
      query.offset,
    );

    return { conversations };
  }

  /**
   * Search conversations by message content or title.
   * NOTE: Must be defined before the :id route to avoid route collision.
   */
  @Get('conversations/search')
  @UseGuards(JwtAuthGuard)
  async searchConversations(
    @CurrentUser() user: { userId: string; email: string },
    @Query() query: SearchConversationsDto,
  ) {
    const results = await this.chatbotService.searchConversations(
      user.userId,
      query.workspaceId,
      query.q,
      query.limit,
    );

    return { conversations: results };
  }

  /**
   * List conversations shared within a workspace.
   * NOTE: Must be defined before the :id route.
   */
  @Get('conversations/shared')
  @UseGuards(JwtAuthGuard)
  async getSharedConversations(
    @Query('workspaceId') workspaceId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    const conversations = await this.chatbotService.listSharedConversations(
      workspaceId,
      limit,
      offset,
    );
    return { conversations };
  }

  /**
   * Get a single conversation with messages.
   */
  @Get('conversations/:id')
  @UseGuards(JwtAuthGuard)
  async getConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    const conversation = await this.chatbotService.getConversation(
      conversationId,
      user.userId,
    );

    return { conversation };
  }

  /**
   * Delete a conversation.
   */
  @Delete('conversations/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    await this.chatbotService.deleteConversation(conversationId, user.userId);
  }

  /**
   * Get messages for a conversation (with pagination).
   */
  @Get('conversations/:id/messages')
  @UseGuards(JwtAuthGuard)
  async getMessages(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Query() query: MessageQueryDto,
  ) {
    const messages = await this.chatbotService.getMessages(
      conversationId,
      user.userId,
      query.limit,
      query.offset,
    );

    return { messages };
  }

  // ==========================================================================
  // Pin & Export
  // ==========================================================================

  /**
   * Toggle pin/unpin a conversation.
   */
  @Patch('conversations/:id/pin')
  @UseGuards(JwtAuthGuard)
  async togglePin(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    const conversation = await this.chatbotService.togglePin(
      conversationId,
      user.userId,
    );
    return { conversation };
  }

  /**
   * Export a conversation as JSON or Markdown.
   */
  @Get('conversations/:id/export')
  @UseGuards(JwtAuthGuard)
  async exportConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Query('format') format?: 'json' | 'markdown',
  ) {
    const result = await this.chatbotService.exportConversation(
      conversationId,
      user.userId,
      format || 'json',
    );
    return result;
  }

  /**
   * Share a conversation with workspace members.
   */
  @Patch('conversations/:id/share')
  @UseGuards(JwtAuthGuard)
  async shareConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    const conversation = await this.chatbotService.shareConversation(
      conversationId,
      user.userId,
    );
    return { conversation };
  }

  /**
   * Unshare a conversation.
   */
  @Patch('conversations/:id/unshare')
  @UseGuards(JwtAuthGuard)
  async unshareConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    const conversation = await this.chatbotService.unshareConversation(
      conversationId,
      user.userId,
    );
    return { conversation };
  }

  /**
   * Get a shared conversation (read-only access for workspace members).
   */
  @Get('conversations/:id/shared')
  @UseGuards(JwtAuthGuard)
  async getSharedConversation(
    @Param('id') conversationId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    const conversation = await this.chatbotService.getSharedConversation(
      conversationId,
      workspaceId,
    );
    return conversation;
  }

  // ==========================================================================
  // Feedback & Regeneration
  // ==========================================================================

  /**
   * Submit feedback (good/bad) on an assistant message.
   */
  @Patch('conversations/:id/messages/:messageId/feedback')
  @UseGuards(JwtAuthGuard)
  async submitFeedback(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: MessageFeedbackDto,
  ) {
    const message = await this.chatbotService.submitFeedback(
      conversationId,
      messageId,
      user.userId,
      dto.rating,
      dto.comment,
    );

    return { message };
  }

  /**
   * Regenerate the last assistant response.
   * Deletes the previous AI answer and streams a new one via SSE.
   */
  @Post('conversations/:id/regenerate')
  @UseGuards(JwtAuthGuard, ChatbotRateLimitGuard)
  async regenerateResponse(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Body() dto: { currentRoute?: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const conversation = await this.chatbotService.getConversation(
      conversationId,
      user.userId,
    );

    const abortController = new AbortController();
    res.on('close', () => {
      abortController.abort();
    });

    try {
      for await (const event of this.chatbotService.regenerateResponse(
        conversationId,
        user.userId,
        conversation.workspaceId,
        dto.currentRoute,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) break;

        res.write(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    } catch (error) {
      this.logger.error(`Regeneration stream error: ${error}`);

      if (!abortController.signal.aborted) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message:
              error instanceof Error ? error.message : 'Regeneration failed',
          })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  }

  // ==========================================================================
  // AI Usage
  // ==========================================================================

  /**
   * Get AI token usage summary for the workspace.
   */
  @Get('usage')
  @UseGuards(JwtAuthGuard)
  async getUsage(@Query() query: UsageQueryDto) {
    const usage = await this.tokenTracking.getUsageSummary(query.workspaceId);
    return { usage };
  }

  // ==========================================================================
  // LLM Provider Management
  // ==========================================================================

  /**
   * Get available LLM providers and the workspace's current preference.
   */
  @Get('providers')
  @UseGuards(JwtAuthGuard)
  async getProviders(@Query('workspaceId') workspaceId: string) {
    const available = this.llmRouter.getAvailableProviders();
    const preference = workspaceId
      ? await this.chatbotService.getProviderPreference(workspaceId)
      : null;
    return { providers: available, current: preference };
  }

  /**
   * Update workspace AI provider preference.
   */
  @Patch('provider-preference')
  @UseGuards(JwtAuthGuard)
  async setProviderPreference(
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { workspaceId: string; provider: string | null },
  ) {
    await this.chatbotService.setProviderPreference(
      body.workspaceId,
      user.userId,
      body.provider,
    );
    return { message: 'Provider preference updated', provider: body.provider };
  }

  // ==========================================================================
  // Chat (SSE Streaming)
  // ==========================================================================

  /**
   * Send a message and receive streaming AI response via SSE.
   *
   * Returns a stream of Server-Sent Events:
   * - thinking_start: AI is processing
   * - thinking_step: AI is performing a specific action
   * - tool_executing: A tool is being called
   * - tool_complete: A tool finished executing
   * - message_stream: Token-by-token response text
   * - message_complete: Full response text
   * - followups: Suggested follow-up actions
   * - actions: UI actions (navigate, theme change, etc.)
   * - error: An error occurred
   * - done: Stream complete
   */
  @Post('conversations/:id/messages')
  @UseGuards(JwtAuthGuard, ChatbotRateLimitGuard)
  async sendMessage(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Need to get workspaceId from the conversation
    const conversation = await this.chatbotService.getConversation(
      conversationId,
      user.userId,
    );

    // Set up abort handling for client disconnect
    const abortController = new AbortController();
    res.on('close', () => {
      abortController.abort();
    });

    try {
      for await (const event of this.chatbotService.processMessage(
        {
          conversationId,
          userId: user.userId,
          workspaceId: conversation.workspaceId,
          message: dto.message,
          currentRoute: dto.currentRoute,
          replyToMessageId: dto.replyToMessageId,
        },
        abortController.signal,
      )) {
        if (abortController.signal.aborted) break;

        res.write(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    } catch (error) {
      this.logger.error(`SSE stream error: ${error}`);

      if (!abortController.signal.aborted) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message:
              error instanceof Error
                ? error.message
                : 'An unexpected error occurred',
          })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  }
}
