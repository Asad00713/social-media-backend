import type { Provider, Type } from '@nestjs/common';

// Owned by Lane A (conversation API). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const CONVERSATION_API_PROVIDERS: Provider[] = [];
export const CONVERSATION_API_CONTROLLERS: Type<unknown>[] = [];
export const CONVERSATION_API_EXPORTS: Provider[] = [];
