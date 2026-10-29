import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AiTextService } from './ai-text.service';
import { AiTokenService, TokenDeductResult } from './services/ai-token.service';
import { QUICK_REPLIES_PROMPT, SYSTEM_PROMPTS, USER_PROMPTS } from './prompts';
import { parseQuickReplies } from './lib/quick-replies';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { loadReplyContext } from '../inbox/conversations/lib/reply-context';

export type SuggestReplyInstruction =
  | 'suggest'
  | 'rephrase'
  | 'shorten'
  | 'friendly'
  | 'translate_en';

export interface SuggestReplyInput {
  /** Server-loaded context; exclusive with `messages`. */
  conversationId?: string;
  commentId?: string;
  /** Legacy caller-supplied context. */
  platform?: string;
  messages?: { author: 'me' | 'customer'; text: string }[];
  instruction?: SuggestReplyInstruction;
  draft?: string;
}

export interface SuggestReplyResult {
  reply: string;
  usage: TokenDeductResult;
}

export interface QuickRepliesInput {
  conversationId: string;
  commentId: string;
}

/**
 * Exactly one of `conversationId` / `messages`; every instruction except
 * `suggest` rewrites a draft, so it needs a non-blank one. 400 otherwise.
 */
export function assertSuggestReplyInput(input: SuggestReplyInput): void {
  const hasConversation = input.conversationId !== undefined;
  const hasMessages = input.messages !== undefined;
  if (hasConversation === hasMessages) {
    throw new BadRequestException(
      'Provide either conversationId or platform + messages',
    );
  }
  if (hasMessages && !input.platform) {
    throw new BadRequestException('platform is required with messages');
  }
  const instruction = input.instruction ?? 'suggest';
  if (instruction !== 'suggest' && !input.draft?.trim()) {
    throw new BadRequestException(`${instruction} requires a draft`);
  }
}

/**
 * Inbox reply drafting. Reuses AiTextService (Gemini primary, Groq fallback)
 * and is metered as one `suggest_reply` unit. When given a `conversationId` it
 * loads the thread itself (workspace-scoped); the legacy `platform` +
 * `messages` body is still accepted.
 */
@Injectable()
export class InboxAiService {
  constructor(
    private readonly aiText: AiTextService,
    private readonly aiTokens: AiTokenService,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  async suggestReply(
    workspaceId: string,
    userId: string,
    input: SuggestReplyInput,
  ): Promise<SuggestReplyResult> {
    assertSuggestReplyInput(input);
    const instruction = input.instruction ?? 'suggest';

    let platform: string;
    let messages: { author: 'me' | 'customer'; text: string }[];
    if (input.conversationId !== undefined) {
      ({ platform, messages } = await loadReplyContext(
        this.db,
        workspaceId,
        input.conversationId,
        input.commentId,
      ));
    } else {
      platform = input.platform as string;
      messages = input.messages as typeof messages;
    }

    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'suggest_reply',
      platform,
      `Inbox reply (${instruction}) on ${platform}`,
      async () => {
        const user = USER_PROMPTS.suggestReply(
          platform,
          messages,
          instruction,
          input.draft,
        );
        const reply = await this.aiText.complete(
          SYSTEM_PROMPTS.inboxReply,
          user,
        );
        return { result: { reply }, outputLength: reply.length };
      },
    );

    return { ...result, usage };
  }

  /** Three short replies to a comment; one `suggest_reply` unit. */
  async quickReplies(
    workspaceId: string,
    userId: string,
    input: QuickRepliesInput,
  ): Promise<{ replies: string[] }> {
    const { platform, messages } = await loadReplyContext(
      this.db,
      workspaceId,
      input.conversationId,
      input.commentId,
    );

    const { result } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'suggest_reply',
      platform,
      `Inbox quick replies on ${platform}`,
      async () => {
        const raw = await this.aiText.complete(
          SYSTEM_PROMPTS.inboxReply,
          QUICK_REPLIES_PROMPT(platform, messages),
        );
        const replies = parseQuickReplies(raw);
        return { result: { replies }, outputLength: raw.length };
      },
    );
    return result;
  }
}
