import type { Provider, Type } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { SavedRepliesController } from './saved-replies.controller';
import { InboxLaterProcessor } from './processors/inbox-later.processor';
import { ConversationListService } from './services/conversation-list.service';
import { SavedRepliesService } from './services/saved-replies.service';
import { ConversationMutationsService } from './services/conversation-mutations.service';
import { LaterWakeService } from './services/later-wake.service';
import { ConversationDetailService } from './services/conversation-detail.service';
import { InboxNotesController } from './inbox-notes.controller';
import { InboxNotesService } from './services/inbox-notes.service';
import { ConversationPresenter } from './services/conversation-presenter.service';

// Owned by Lane A (conversation API). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const CONVERSATION_API_PROVIDERS: Provider[] = [
  ConversationListService,
  SavedRepliesService,
  LaterWakeService,
  ConversationMutationsService,
  InboxNotesService,
  ConversationDetailService,
  InboxLaterProcessor,
];
export const CONVERSATION_API_CONTROLLERS: Type<unknown>[] = [
  ConversationsController,
  SavedRepliesController,
  InboxNotesController,
];
// Maestro's read tools consume list, detail and counts. The presenter is
// provided by InboxModule itself; exporting it here leaves that file alone.
export const CONVERSATION_API_EXPORTS: Provider[] = [
  ConversationListService,
  ConversationDetailService,
  ConversationPresenter,
];
