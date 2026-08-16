import { DiscordPublisher } from './discord.publisher';
import type { PublishOptions } from './base.publisher';

function baseOptions(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    content: 'gm',
    mediaItems: [],
    metadata: { destination: { id: 'D999', name: 'general' } },
    accessToken: 'ignored',
    platformAccountId: 'guild1',
    channelMetadata: {},
    channelId: 3,
    ...over,
  };
}

describe('DiscordPublisher', () => {
  function make() {
    const createMessage = jest.fn().mockResolvedValue({ id: 'msg-1' });
    const discordService = { createMessage } as never;
    return { publisher: new DiscordPublisher(discordService), createMessage };
  }

  it('rejects a missing destination', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ metadata: {} }))).toThrow(/destination/i);
  });

  it('rejects more than one media item', () => {
    const { publisher } = make();
    const media = [
      { url: 'a', type: 'image' as const },
      { url: 'b', type: 'image' as const },
    ];
    expect(() => publisher.validate(baseOptions({ mediaItems: media }))).toThrow(/one media/i);
  });

  it('sends a text-only message to the destination channel', async () => {
    const { publisher, createMessage } = make();
    const res = await publisher.publish(baseOptions());
    expect(createMessage).toHaveBeenCalledWith('D999', { content: 'gm', files: undefined });
    expect(res.platformPostId).toBe('msg-1');
  });
});
