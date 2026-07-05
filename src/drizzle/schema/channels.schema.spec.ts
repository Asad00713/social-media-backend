import { PLATFORM_CONFIG } from './channels.schema';

describe('Threads OAuth scopes', () => {
  it('requests all 6 scopes the features need', () => {
    expect(PLATFORM_CONFIG.threads.oauthScopes).toEqual([
      'threads_basic',
      'threads_content_publish',
      'threads_manage_replies',
      'threads_read_replies',
      'threads_manage_insights',
      'threads_manage_mentions',
    ]);
  });
});
