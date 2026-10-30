// workspaceGuilds() reads the connected Discord channel rows through the
// module-level `db`; script it with a thenable chain.
jest.mock('../../drizzle/db', () => {
  const rows = [
    {
      id: 5,
      platform: 'discord',
      workspaceId: 'ws-1',
      platformAccountId: 'g1',
      accountName: 'Guild',
      connectionStatus: 'connected',
    },
  ];
  const c: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => res(rows);
        return () => c;
      },
    },
  );
  return { db: { select: () => c } };
});

import { createDiscordTools } from './discord.tools';

describe('send_discord_message', () => {
  it('records the send with the acting user as author (so R5 does not read it as a platform reply)', async () => {
    const discord = {
      listGuildChannels: jest
        .fn()
        .mockResolvedValue([{ id: 'c1', name: 'general' }]),
      createMessage: jest.fn().mockResolvedValue({ id: 'sent-1' }),
    };
    const inbox = { recordOutgoingDiscordMessage: jest.fn() };
    const tool = createDiscordTools(discord as never, inbox as never, {
      confirmBeforeSend: false,
    }).find((t) => t.name === 'send_discord_message')!;

    await tool.handler(
      { channel: 'general', message: 'hello' },
      { userId: 'u1', workspaceId: 'ws-1' },
    );

    expect(inbox.recordOutgoingDiscordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        channelId: 5,
        conversationId: 'c1',
        platformItemId: 'sent-1',
        authoredByUserId: 'u1',
      }),
    );
  });
});
