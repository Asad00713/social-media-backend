import { NotFoundException } from '@nestjs/common';
import { MediaSourcesService } from './media-sources.service';

// A channel that belongs to another workspace must never be browsed or imported
// from, whatever :workspaceId the caller put in the URL.
function build() {
  const channelService = {
    getChannelById: jest.fn(),
    getAccessToken: jest.fn(),
  };
  const dropbox = { listMedia: jest.fn(), downloadFile: jest.fn() };
  const cloudinary = { uploadFromBuffer: jest.fn() };
  const svc = new MediaSourcesService(
    channelService as never,
    dropbox as never,
    {} as never,
    {} as never,
    {} as never,
    cloudinary as never,
  );
  return { svc, channelService, dropbox, cloudinary };
}

describe('media sources are scoped to the path workspace', () => {
  it('browse: a channel of another workspace is NotFound, no token fetched', async () => {
    const { svc, channelService, dropbox } = build();
    channelService.getChannelById.mockRejectedValue(
      new NotFoundException('Channel not found'),
    );
    await expect(
      svc.browse('victim-ws', 5, { kind: 'media' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(channelService.getChannelById).toHaveBeenCalledWith(5, 'victim-ws');
    expect(channelService.getAccessToken).not.toHaveBeenCalled();
    expect(dropbox.listMedia).not.toHaveBeenCalled();
  });

  it('import: a channel of another workspace is NotFound, nothing downloaded or uploaded', async () => {
    const { svc, channelService, dropbox, cloudinary } = build();
    channelService.getChannelById.mockRejectedValue(
      new NotFoundException('Channel not found'),
    );
    await expect(
      svc.import('victim-ws', 5, { fileId: '/a.jpg' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(channelService.getChannelById).toHaveBeenCalledWith(5, 'victim-ws');
    expect(channelService.getAccessToken).not.toHaveBeenCalled();
    expect(dropbox.downloadFile).not.toHaveBeenCalled();
    expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
  });
});
