import type { Provider, Type } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { SavedRepliesController } from './saved-replies.controller';
import { ConversationListService } from './services/conversation-list.service';
import { SavedRepliesService } from './services/saved-replies.service';

// Owned by Lane A (conversation API). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const CONVERSATION_API_PROVIDERS: Provider[] = [
  ConversationListService,
  SavedRepliesService,
];
export const CONVERSATION_API_CONTROLLERS: Type<unknown>[] = [
  ConversationsController,
  SavedRepliesController,
];
export const CONVERSATION_API_EXPORTS: Provider[] = [ConversationListService];
