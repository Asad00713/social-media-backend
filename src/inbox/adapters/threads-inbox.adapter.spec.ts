import { ThreadsInboxAdapter } from './threads-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel: ResolvedChannel = {
  id: 1, workspaceId: 'w1', platform: 'threads',
  platformAccountId: 'acc1', accessToken: 'tok', metadata: {},
  username: 'schedura', accountName: 'Schedura', profilePictureUrl: null,
};

describe('ThreadsInboxAdapter mentions + hide', () => {
  it('fetchMentions maps mentions to FetchedComment', async () => {
    const threads = {
      getMentions: jest.fn().mockResolvedValue([
        { id: 'm1', text: 'hi @schedura', authorUsername: 'bob',
          permalink: 'p', timestamp: '2026-07-01T10:00:00+0000', mediaType: 'TEXT_POST' },
      ]),
    } as any;
    const adapter = new ThreadsInboxAdapter(threads);
    const out = await adapter.fetchMentions!(channel);
    expect(threads.getMentions).toHaveBeenCalledWith('tok', 'acc1', undefined);
    expect(out[0]).toMatchObject({
      platformItemId: 'm1', text: 'hi @schedura', authorHandle: 'bob', fromMe: false,
    });
  });

  it('hideComment calls manageReply', async () => {
    const threads = { manageReply: jest.fn().mockResolvedValue(undefined) } as any;
    const adapter = new ThreadsInboxAdapter(threads);
    await adapter.hideComment!(channel, 'reply5', true);
    expect(threads.manageReply).toHaveBeenCalledWith('tok', 'reply5', true);
  });
});
