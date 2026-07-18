import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MediaSourcesService } from './media-sources.service';
import { ChannelService } from '../channels/services/channel.service';
import { DropboxService } from '../channels/services/dropbox.service';
import {
  GoogleDriveService,
  DriveApiError,
} from '../channels/services/google-drive.service';
import { OneDriveService } from '../channels/services/onedrive.service';
import { GooglePhotosService } from '../channels/services/google-photos.service';
import { CloudinaryService } from '../media/cloudinary.service';

const channelService = {
  getChannelById: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('TKN'),
};
const dropbox = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const drive = { downloadFile: jest.fn() };
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

// Under drive.file the server can only read files the user picked with the SAME
// Google account the channel was connected with. Picking from another account is
// the single most likely live failure, so it must name the fix, not 500.
it('import maps a Drive 404 to an actionable account-mismatch error', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('File not found', 404));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    /Choose files from your connected Google Drive account/,
  );
});

// The advice only helps if it names the account the way Google does. The Picker's
// login hint and the pane's "Connected as" line both use the email (`username`),
// so the toast must not name a display name instead — three different names for
// one account is how a user re-picks the wrong one.
it('import names the connected account by email, not display name', async () => {
  channelService.getChannelById.mockResolvedValue({
    platform: 'google_drive',
    username: 'someone@gmail.com',
    accountName: 'Someone Nice',
  });
  drive.downloadFile.mockRejectedValue(new DriveApiError('File not found', 404));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    /someone@gmail\.com/,
  );
});

it('import falls back to the display name when the channel carries no email', async () => {
  channelService.getChannelById.mockResolvedValue({
    platform: 'google_drive',
    username: null,
    accountName: 'Someone Nice',
  });
  drive.downloadFile.mockRejectedValue(new DriveApiError('File not found', 404));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    /Someone Nice/,
  );
});

it('import maps a Drive 403 to the same actionable error', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('Forbidden', 403));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toBeInstanceOf(
    BadRequestException,
  );
});

it('import lets a non-permission Drive failure surface as-is', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('Drive is down', 500));
  const svc = await build();
  // A 500 is not the user's fault — do not tell them to pick a different account.
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    'Drive is down',
  );
});

it('import on google_drive downloads and uploads on the happy path', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockResolvedValue(Buffer.from('z'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/z.jpg', width: 10, height: 20, duration: undefined, bytes: 7, resourceType: 'image', publicId: 'r' });
  const svc = await build();
  const res = await svc.import('ws', 3, { fileId: 'f1', kind: 'image' });
  expect(drive.downloadFile).toHaveBeenCalledWith('TKN', 'f1');
  expect(res).toEqual({ url: 'https://cdn/z.jpg', type: 'image', width: 10, height: 20, durationSec: undefined, sizeBytes: 7 });
});
