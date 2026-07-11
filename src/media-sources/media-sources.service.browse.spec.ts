import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MediaSourcesService } from './media-sources.service';
import { ChannelService } from '../channels/services/channel.service';
import { DropboxService } from '../channels/services/dropbox.service';
import { GoogleDriveService } from '../channels/services/google-drive.service';
import { OneDriveService } from '../channels/services/onedrive.service';
import { GooglePhotosService } from '../channels/services/google-photos.service';
import { CloudinaryService } from '../media/cloudinary.service';

const channelService = {
  getChannelById: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('TKN'),
};
const dropbox = { listMedia: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const drive = { listMedia: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const onedrive = { listMedia: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const photos = { listMediaItems: jest.fn(), listAlbums: jest.fn(), downloadMediaItem: jest.fn() };
const cloudinary = { uploadFromBuffer: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      MediaSourcesService,
      { provide: ChannelService, useValue: channelService },
      { provide: DropboxService, useValue: dropbox },
      { provide: GoogleDriveService, useValue: drive },
      { provide: OneDriveService, useValue: onedrive },
      { provide: GooglePhotosService, useValue: photos },
      { provide: CloudinaryService, useValue: cloudinary },
    ],
  }).compile();
  return mod.get(MediaSourcesService);
}

beforeEach(() => jest.clearAllMocks());

it('browse(media) on dropbox resolves token by channelId and maps entries', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listMedia.mockResolvedValue({
    entries: [{ '.tag': 'file', id: 'i', name: 'a.jpg', path_lower: '/a.jpg', path_display: '/a.jpg', size: 10, media_info: { metadata: { '.tag': 'photo' } } }],
    cursor: 'C', has_more: true,
  });
  const svc = await build();
  const res = await svc.browse('ws', 5, { kind: 'media' });
  expect(channelService.getAccessToken).toHaveBeenCalledWith(5, 'ws');
  expect(dropbox.listMedia).toHaveBeenCalledWith('TKN', { path: undefined, limit: undefined, cursor: undefined });
  expect(res.items[0]).toMatchObject({ id: '/a.jpg', kind: 'image', name: 'a.jpg' });
  expect(res.nextCursor).toBe('C');
});

it('rejects a non-cloud channel', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'twitter' });
  const svc = await build();
  await expect(svc.browse('ws', 1, { kind: 'media' })).rejects.toBeInstanceOf(BadRequestException);
});
