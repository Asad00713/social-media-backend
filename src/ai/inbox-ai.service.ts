import { Injectable } from '@nestjs/common';
import { AiTextService } from './ai-text.service';
import { AiTokenService, TokenDeductResult } from './services/ai-token.service';
import { SYSTEM_PROMPTS, USER_PROMPTS } from './prompts';

export interface SuggestReplyInput {
  platform: string;
  messages: { author: 'me' | 'customer'; text: string }[];
  instruction?: 'suggest' | 'rephrase' | 'shorten' | 'friendly';
  draft?: string;
}

export interface SuggestReplyResult {
  reply: string;
  usage: TokenDeductResult;
}

/**
 * Single-shot inbox reply drafting. Reuses AiTextService (Gemini primary,
 * Groq fallback) and is metered as one `suggest_reply` unit. Stateless — it
 * uses the messages passed in, never re-fetches the thread.
 */
@Injectable()
export class InboxAiService {
  constructor(
    private readonly aiText: AiTextService,
    private readonly aiTokens: AiTokenService,
  ) {}

  async suggestReply(
    workspaceId: string,
    userId: string,
    input: SuggestReplyInput,
  ): Promise<SuggestReplyResult> {
    const { platform, messages, instruction = 'suggest', draft } = input;

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
          draft,
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
}
