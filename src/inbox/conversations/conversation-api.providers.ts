import type { Provider, Type } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationListService } from './services/conversation-list.service';

// Owned by Lane A (conversation API). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const CONVERSATION_API_PROVIDERS: Provider[] = [ConversationListService];
export const CONVERSATION_API_CONTROLLERS: Type<unknown>[] = [
  ConversationsController,
];
export const CONVERSATION_API_EXPORTS: Provider[] = [ConversationListService];
