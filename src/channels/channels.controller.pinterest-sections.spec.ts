import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ChannelsController } from './channels.controller';

/**
 * The two routes behind the composer's board-section picker. The thing worth
 * pinning is the guard before the token is read: a channel id from another
 * platform must not have its OAuth token handed to Pinterest's API.
 */
describe('ChannelsController — Pinterest board sections', () => {
  function controller(platform: string) {
    const c: any = Object.create(ChannelsController.prototype);
    c.channelService = {
      getChannelById: jest.fn().mockResolvedValue({ id: 7, platform }),
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    };
    c.pinterestService = {
      listBoardSections: jest.fn().mockResolvedValue([{ id: 's1', name: 'A' }]),
      createBoardSection: jest.fn().mockResolvedValue({ id: 's2', name: 'B' }),
    };
    return c;
  }

  it('lists a board’s sections with the channel’s own token', async () => {
    const c = controller('pinterest');

    const result = await c.listPinterestBoardSectionsForChannel(
      'ws-1',
      '7',
      'board-9',
    );

    expect(c.channelService.getChannelById).toHaveBeenCalledWith(7, 'ws-1');
    expect(c.channelService.getAccessToken).toHaveBeenCalledWith(7, 'ws-1');
    expect(c.pinterestService.listBoardSections).toHaveBeenCalledWith(
      'tok',
      'board-9',
    );
    expect(result).toEqual({ sections: [{ id: 's1', name: 'A' }] });
  });

  it('refuses to list for a channel that is not Pinterest, before reading its token', async () => {
    const c = controller('instagram');

    await expect(
      c.listPinterestBoardSectionsForChannel('ws-1', '7', 'board-9'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(c.channelService.getAccessToken).not.toHaveBeenCalled();
    expect(c.pinterestService.listBoardSections).not.toHaveBeenCalled();
  });

  it('creates a section on the chosen board', async () => {
    const c = controller('pinterest');

    const result = await c.createPinterestBoardSection('ws-1', '7', 'board-9', {
      name: 'B',
    });

    expect(c.pinterestService.createBoardSection).toHaveBeenCalledWith(
      'tok',
      'board-9',
      'B',
    );
    expect(result.section).toEqual({ id: 's2', name: 'B' });
  });

  it('refuses to create for a channel that is not Pinterest, before reading its token', async () => {
    const c = controller('tiktok');

    await expect(
      c.createPinterestBoardSection('ws-1', '7', 'board-9', { name: 'B' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(c.channelService.getAccessToken).not.toHaveBeenCalled();
    expect(c.pinterestService.createBoardSection).not.toHaveBeenCalled();
  });
});
