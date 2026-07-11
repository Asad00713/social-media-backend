import { Test } from '@nestjs/testing';
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
const dropbox = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const drive = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const onedrive = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const photos = { listMediaItems: jest.fn(), listPhotos: jest.fn(), listVideos: jest.fn(), listAlbums: jest.fn(), downloadMediaItem: jest.fn(), getMediaItem: jest.fn() };
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

it('import downloads provider buffer and uploads to cloudinary', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.downloadFile.mockResolvedValue(Buffer.from('x'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/x.jpg', width: 800, height: 600, duration: undefined, bytes: 1234, resourceType: 'image', publicId: 'p' });
  const svc = await build();
  const res = await svc.import('ws', 5, { fileId: '/x.jpg', kind: 'image' });
  expect(dropbox.downloadFile).toHaveBeenCalledWith('TKN', '/x.jpg');
  expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), { folder: 'composer/cloud', resourceType: 'auto' });
  expect(res).toEqual({ url: 'https://cdn/x.jpg', type: 'image', width: 800, height: 600, durationSec: undefined, sizeBytes: 1234 });
});

it('import derives type from the cloudinary upload result, ignoring a mismatched client-supplied kind', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.downloadFile.mockResolvedValue(Buffer.from('x'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/x.mp4', width: 800, height: 600, duration: 5, bytes: 1234, resourceType: 'video', publicId: 'p' });
  const svc = await build();
  // Client claims 'image' but Cloudinary detected a video — result must reflect Cloudinary's detection.
  const res = await svc.import('ws', 5, { fileId: '/x.mp4', kind: 'image' });
  expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), { folder: 'composer/cloud', resourceType: 'auto' });
  expect(res.type).toBe('video');
});

it('import on google_photos fetches media item then downloads it', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_photos' });
  const mediaItem = { id: 'm1', baseUrl: 'https://photos/m1', mimeType: 'video/mp4', filename: 'a.mp4', mediaMetadata: { creationTime: 't', width: '100', height: '200', video: {} } };
  photos.getMediaItem.mockResolvedValue(mediaItem);
  photos.downloadMediaItem.mockResolvedValue(Buffer.from('y'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/y.mp4', width: undefined, height: undefined, duration: 12, bytes: 42, resourceType: 'video', publicId: 'q' });
  const svc = await build();
  const res = await svc.import('ws', 9, { fileId: 'm1', kind: 'video' });
  expect(photos.getMediaItem).toHaveBeenCalledWith('TKN', 'm1');
  expect(photos.downloadMediaItem).toHaveBeenCalledWith('TKN', mediaItem);
  expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), { folder: 'composer/cloud', resourceType: 'auto' });
  expect(res).toEqual({ url: 'https://cdn/y.mp4', type: 'video', width: undefined, height: undefined, durationSec: 12, sizeBytes: 42 });
});

it('rejects import on a non-cloud channel', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'twitter' });
  const svc = await build();
  await expect(svc.import('ws', 1, { fileId: 'x', kind: 'image' })).rejects.toBeInstanceOf(
    require('@nestjs/common').BadRequestException,
  );
});
