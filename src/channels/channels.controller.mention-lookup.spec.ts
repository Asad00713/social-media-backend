import { BadRequestException } from '@nestjs/common';
import { ChannelsController } from './channels.controller';

/**
 * `GET channels/workspaces/:ws/:channel/mention-lookup` — the thin route in
 * front of MentionLookupService. Built without Nest's container: the
 * controller has thirty collaborators and this route touches three.
 */
describe('ChannelsController.lookupMention', () => {
  const build = (platform: string) => {
    const controller = Object.create(
      ChannelsController.prototype,
    ) as ChannelsController;
    const deps = {
      channelService: {
        getChannelById: jest.fn().mockResolvedValue({
          platform,
          metadata: { instanceUrl: 'm.test' },
        }),
        getAccessToken: jest.fn().mockResolvedValue('tok'),
      },
      mentionLookup: {
        lookup: jest.fn().mockResolvedValue({ handle: 'ann', found: true }),
      },
    };
    Object.assign(controller, deps);
    return { controller, ...deps };
  };

  it('checks a Mastodon handle with the channel’s token and server', async () => {
    const { controller, channelService, mentionLookup } = build('mastodon');

    await expect(controller.lookupMention('ws', '7', 'ann')).resolves.toEqual({
      handle: 'ann',
      found: true,
    });
    expect(channelService.getChannelById).toHaveBeenCalledWith(7, 'ws');
    expect(channelService.getAccessToken).toHaveBeenCalledWith(7, 'ws');
    expect(mentionLookup.lookup).toHaveBeenCalledWith(
      'mastodon',
      'tok',
      { instanceUrl: 'm.test' },
      'ann',
    );
  });

  it('refuses a network it cannot check, before reading any token', async () => {
    const { controller, channelService } = build('twitter');

    await expect(controller.lookupMention('ws', '7', 'ann')).rejects.toThrow(
      BadRequestException,
    );
    expect(channelService.getAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a missing handle', async () => {
    const { controller } = build('bluesky');

    await expect(
      controller.lookupMention('ws', '7', undefined),
    ).rejects.toThrow('A handle to check is required');
  });
});
