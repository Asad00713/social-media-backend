import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { eq, desc, and, sql, ilike, or } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  conversations,
  chatMessages,
  MessageRole,
} from '../../drizzle/schema/chatbot.schema';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Create a new conversation.
   */
  async create(userId: string, workspaceId: string, title?: string) {
    const [conversation] = await this.db
      .insert(conversations)
      .values({
        userId,
        workspaceId,
        title: title || null,
      })
      .returning();

    this.logger.log(
      `Created conversation ${conversation.id} for user ${userId}`,
    );
    return conversation;
  }

  /**
   * Get a conversation by ID.
   */
  async findById(conversationId: string) {
    const conversation = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    return conversation;
  }

  /**
   * List conversations for a user in a workspace.
   */
  async list(userId: string, workspaceId: string, limit = 20, offset = 0) {
    const results = await this.db.query.conversations.findMany({
      where: and(
        eq(conversations.userId, userId),
        eq(conversations.workspaceId, workspaceId),
      ),
      orderBy: [desc(conversations.isPinned), desc(conversations.updatedAt)],
      limit,
      offset,
    });

    return results;
  }

  /**
   * Delete a conversation and all its messages.
   */
  async delete(conversationId: string, userId: string) {
    const conversation = await this.findById(conversationId);

    if (conversation.userId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    await this.db
      .delete(conversations)
      .where(eq(conversations.id, conversationId));

    this.logger.log(`Deleted conversation ${conversationId}`);
  }

  /**
   * Update conversation title.
   */
  async updateTitle(conversationId: string, title: string) {
    await this.db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * Add a message to a conversation.
   */
  async addMessage(
    conversationId: string,
    role: MessageRole,
    content: string | null,
    metadata?: Record<string, any>,
    modelUsed?: string,
    tokenCount?: number,
    replyToId?: string,
  ) {
    const [message] = await this.db
      .insert(chatMessages)
      .values({
        conversationId,
        role,
        content,
        metadata: metadata || null,
        modelUsed: modelUsed || null,
        tokenCount: tokenCount || null,
        replyToId: replyToId || null,
      })
      .returning();

    // Update conversation's updatedAt (non-blocking — never fails the message save)
    this.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId))
      .catch((err) =>
        this.logger.warn(`Failed to update conversation timestamp: ${err}`),
      );

    return message;
  }

  /**
   * Set (or clear) a user's 👍/👎 feedback on a message they own.
   */
  async setMessageFeedback(
    messageId: string,
    userId: string,
    feedback: 'good' | 'bad' | null,
  ) {
    const message = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, messageId),
      with: { conversation: { columns: { userId: true } } },
    });
    if (!message || message.conversation?.userId !== userId) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }
    await this.db
      .update(chatMessages)
      .set({ feedback })
      .where(eq(chatMessages.id, messageId));
  }

  /**
   * Find a single message by ID.
   */
  async findMessageById(messageId: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, messageId),
    });
    return message || null;
  }

  /**
   * Get messages for a conversation (ordered chronologically).
   * Includes replied-to message preview for quote rendering.
   */
  async getMessages(conversationId: string, limit = 50, offset = 0) {
    const messages = await this.db.query.chatMessages.findMany({
      where: eq(chatMessages.conversationId, conversationId),
      orderBy: chatMessages.createdAt,
      limit,
      offset,
      with: {
        replyTo: {
          columns: { id: true, role: true, content: true },
        },
      },
    });

    return messages;
  }

  /**
   * Get the last N messages for context building.
   * Returns messages in chronological order.
   */
  async getRecentMessages(conversationId: string, count = 50) {
    // Get last N messages ordered by most recent, then reverse
    const messages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(count);

    return messages.reverse();
  }

  /**
   * Replace one message's metadata blob.
   *
   * Used to mark a Maestro confirm card resolved once its action has run (or
   * been declined), so the same approval cannot be replayed.
   */
  async setMessageMetadata(
    messageId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.db
      .update(chatMessages)
      .set({ metadata })
      .where(eq(chatMessages.id, messageId));
  }

  /**
   * Auto-generate a title from the first user message.
   */
  async autoGenerateTitle(conversationId: string, firstMessage: string) {
    // Truncate to first 80 chars for the title
    const title =
      firstMessage.length > 80
        ? firstMessage.substring(0, 77) + '...'
        : firstMessage;

    await this.updateTitle(conversationId, title);
  }

  /**
   * Set feedback (good/bad) on a message.
   */
  async setFeedback(
    messageId: string,
    rating: 'good' | 'bad',
    comment?: string,
  ) {
    const [updated] = await this.db
      .update(chatMessages)
      .set({
        feedback: rating,
        feedbackComment: comment || null,
      })
      .where(eq(chatMessages.id, messageId))
      .returning();

    if (!updated) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }

    return updated;
  }

  /**
   * Delete the last assistant message in a conversation (for regeneration).
   * Returns the user message that triggered it so we can re-run the agent.
   */
  async deleteLastAssistantMessage(conversationId: string) {
    // Get the last assistant message
    const lastAssistant = await this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          eq(chatMessages.role, 'assistant'),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);

    if (!lastAssistant.length) {
      throw new NotFoundException('No assistant message to regenerate');
    }

    // Delete the assistant message
    await this.db
      .delete(chatMessages)
      .where(eq(chatMessages.id, lastAssistant[0].id));

    // Get the last user message (the one that triggered the deleted response)
    const lastUser = await this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          eq(chatMessages.role, 'user'),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);

    return lastUser[0] || null;
  }

  /**
   * Search conversations by message content or title.
   */
  async search(userId: string, workspaceId: string, query: string, limit = 20) {
    const searchTerm = `%${query}%`;

    // Find conversations where title or any message content matches
    const matchingConversationIds = await this.db
      .selectDistinct({ id: conversations.id })
      .from(conversations)
      .leftJoin(chatMessages, eq(chatMessages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.workspaceId, workspaceId),
          or(
            ilike(conversations.title, searchTerm),
            ilike(chatMessages.content, searchTerm),
          ),
        ),
      )
      .limit(limit);

    if (matchingConversationIds.length === 0) return [];

    const ids = matchingConversationIds.map((r) => r.id);

    return this.db.query.conversations.findMany({
      where: and(
        eq(conversations.userId, userId),
        sql`${conversations.id} = ANY(ARRAY[${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`,
      ),
      orderBy: [desc(conversations.isPinned), desc(conversations.updatedAt)],
    });
  }

  /**
   * Toggle pin status on a conversation.
   */
  async togglePin(conversationId: string, userId: string) {
    const conversation = await this.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const [updated] = await this.db
      .update(conversations)
      .set({ isPinned: !conversation.isPinned, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId))
      .returning();

    return updated;
  }

  /**
   * Export a conversation in the specified format.
   */
  async exportConversation(
    conversationId: string,
    userId: string,
    format: 'json' | 'markdown' = 'json',
  ) {
    const conversation = await this.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const messages = await this.getMessages(conversationId, 1000);

    if (format === 'markdown') {
      const lines: string[] = [
        `# ${conversation.title || 'Untitled Conversation'}`,
        `*Exported on ${new Date().toISOString()}*`,
        '',
      ];

      for (const msg of messages) {
        if (msg.role === 'tool' || msg.role === 'system') continue;
        const label = msg.role === 'user' ? '**You**' : '**Assistant**';
        lines.push(`### ${label}`);
        lines.push(msg.content || '*[no content]*');
        lines.push('');
      }

      return { format: 'markdown', content: lines.join('\n') };
    }

    // JSON format
    return {
      format: 'json',
      content: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        messages: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
          })),
      },
    };
  }

  /**
   * Share a conversation with all workspace members.
   */
  async shareConversation(conversationId: string, userId: string) {
    const conversation = await this.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const [updated] = await this.db
      .update(conversations)
      .set({
        sharedWithWorkspace: true,
        sharedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning();

    return updated;
  }

  /**
   * Unshare a conversation.
   */
  async unshareConversation(conversationId: string, userId: string) {
    const conversation = await this.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const [updated] = await this.db
      .update(conversations)
      .set({
        sharedWithWorkspace: false,
        sharedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning();

    return updated;
  }

  /**
   * List conversations shared within a workspace.
   */
  async listShared(workspaceId: string, limit = 20, offset = 0) {
    return this.db.query.conversations.findMany({
      where: and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.sharedWithWorkspace, true),
      ),
      orderBy: [desc(conversations.sharedAt)],
      limit,
      offset,
    });
  }

  /**
   * Find a shared conversation by ID (read access for workspace members).
   */
  async findSharedById(conversationId: string, workspaceId: string) {
    const conversation = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.sharedWithWorkspace, true),
      ),
    });

    if (!conversation) {
      throw new NotFoundException('Shared conversation not found');
    }

    return conversation;
  }
}
