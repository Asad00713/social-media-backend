import type { Provider, Type } from '@nestjs/common';
import { CommentActionsController } from './comment-actions.controller';
import { CommentActionsService } from './services/comment-actions.service';

// Owned by Lane B (messaging and platform actions). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const MESSAGING_PROVIDERS: Provider[] = [CommentActionsService];
export const MESSAGING_CONTROLLERS: Type<unknown>[] = [
  CommentActionsController,
];
