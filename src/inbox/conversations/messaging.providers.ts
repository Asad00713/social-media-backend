import type { Provider, Type } from '@nestjs/common';

// Owned by Lane B (messaging and platform actions). Spread into InboxModule once, so lanes never edit inbox.module.ts.
export const MESSAGING_PROVIDERS: Provider[] = [];
export const MESSAGING_CONTROLLERS: Type<unknown>[] = [];
