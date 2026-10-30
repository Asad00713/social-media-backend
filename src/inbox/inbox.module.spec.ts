import { MODULE_METADATA } from '@nestjs/common/constants';
import { QUEUES } from '../queue/queue.module';
import { InboxModule } from './inbox.module';
import { ConversationSyncService } from './conversations/services/conversation-sync.service';
import {
  CONVERSATION_API_CONTROLLERS,
  CONVERSATION_API_EXPORTS,
  CONVERSATION_API_PROVIDERS,
} from './conversations/conversation-api.providers';
import {
  MESSAGING_CONTROLLERS,
  MESSAGING_PROVIDERS,
} from './conversations/messaging.providers';

describe('InboxModule lane seams', () => {
  const meta = (key: string): unknown[] =>
    Reflect.getMetadata(key, InboxModule) as unknown[];

  it('spreads every lane array into the module metadata', () => {
    for (const arr of [
      CONVERSATION_API_PROVIDERS,
      CONVERSATION_API_CONTROLLERS,
      CONVERSATION_API_EXPORTS,
      MESSAGING_PROVIDERS,
      MESSAGING_CONTROLLERS,
    ]) {
      expect(Array.isArray(arr)).toBe(true);
    }
    expect(meta(MODULE_METADATA.PROVIDERS)).toEqual(
      expect.arrayContaining([
        ...CONVERSATION_API_PROVIDERS,
        ...MESSAGING_PROVIDERS,
      ]),
    );
    expect(meta(MODULE_METADATA.CONTROLLERS)).toEqual(
      expect.arrayContaining([
        ...CONVERSATION_API_CONTROLLERS,
        ...MESSAGING_CONTROLLERS,
      ]),
    );
    expect(meta(MODULE_METADATA.EXPORTS)).toEqual(
      expect.arrayContaining([...CONVERSATION_API_EXPORTS]),
    );
  });

  it('registers the Later queue with a colon-free name', () => {
    expect(QUEUES.INBOX_LATER).toBe('inbox-later');
    expect(QUEUES.INBOX_LATER).not.toContain(':');
  });

  it('exports ConversationSyncService for the channels module (YouTube data deletion)', () => {
    expect(meta(MODULE_METADATA.EXPORTS)).toContain(ConversationSyncService);
  });
});
