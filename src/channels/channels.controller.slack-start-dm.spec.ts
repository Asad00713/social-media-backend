import 'reflect-metadata';
import { ChannelsController } from './channels.controller';

describe('ChannelsController.startSlackDm', () => {
  it('records the first message with the teammate as its author (not a platform reply)', async () => {
    const c: any = Object.create(ChannelsController.prototype);
    c.channelService = {
      getChannelById: jest.fn().mockResolvedValue({ id: 3, platform: 'slack' }),
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    };
    c.slackService = {
      openDmAndSendFirst: jest
        .fn()
        .mockResolvedValue({ conversationId: 'D1', ts: '1700000000.0001' }),
      getUserInfo: jest.fn().mockResolvedValue(null),
    };
    c.inboxService = { upsertDm: jest.fn().mockResolvedValue(null) };

    await c.startSlackDm(
      'ws-1',
      '3',
      { userId: 'U9', text: 'hello' },
      { userId: 'teammate-1', email: 't@example.com' },
    );

    expect(c.inboxService.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        channelId: 3,
        platform: 'slack',
        fromMe: true,
        authoredByUserId: 'teammate-1',
      }),
    );
  });
});
