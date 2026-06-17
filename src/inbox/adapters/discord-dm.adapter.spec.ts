import { DiscordDmAdapter } from './discord-dm.adapter';

describe('DiscordDmAdapter', () => {
  const discord = {
    createMessage: jest.fn().mockResolvedValue({ id: 'm1', channelId: 'c1' }),
    deleteMessage: jest.fn().mockResolvedValue(true),
  } as any;
  const adapter = new DiscordDmAdapter(discord);

  beforeEach(() => jest.clearAllMocks());

  it('always reports canReply true (no messaging window)', async () => {
    await expect(adapter.getReplyWindowState()).resolves.toEqual({
      canReply: true,
    });
  });

  it('sends a text DM via createMessage', async () => {
    const res = await adapter.sendDm({} as any, 'c1', 'hi');
    expect(discord.createMessage).toHaveBeenCalledWith('c1', { content: 'hi' });
    expect(res.platformItemId).toBe('m1');
    expect(res.conversationId).toBe('c1');
  });

  it('deletes a message via deleteMessage', async () => {
    await expect(adapter.deleteDm({} as any, 'c1', 'm1')).resolves.toBe(true);
    expect(discord.deleteMessage).toHaveBeenCalledWith('c1', 'm1');
  });

  it('exposes platform "discord"', () => {
    expect(adapter.platform).toBe('discord');
  });
});
