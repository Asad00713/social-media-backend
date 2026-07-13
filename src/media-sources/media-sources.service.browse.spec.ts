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
const dropbox = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn(), getThumbnailBatch: jest.fn() };
const drive = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const onedrive = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const photos = { listMediaItems: jest.fn(), listPhotos: jest.fn(), listVideos: jest.fn(), listAlbums: jest.fn(), downloadMediaItem: jest.fn() };
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

beforeEach(() => {
  jest.clearAllMocks();
  dropbox.getThumbnailBatch.mockResolvedValue(new Map());
});

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

// FIX 1 — images/videos kinds must call the provider's filtered method, not listMedia.

it("browse(videos) on dropbox calls listVideos, not listMedia", async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listVideos.mockResolvedValue({ entries: [], has_more: false });
  const svc = await build();
  await svc.browse('ws', 1, { kind: 'videos' });
  expect(dropbox.listVideos).toHaveBeenCalled();
  expect(dropbox.listMedia).not.toHaveBeenCalled();
});

it("browse(videos) on google_drive calls listVideos, not listMedia", async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.listVideos.mockResolvedValue({ files: [] });
  const svc = await build();
  await svc.browse('ws', 1, { kind: 'videos' });
  expect(drive.listVideos).toHaveBeenCalled();
  expect(drive.listMedia).not.toHaveBeenCalled();
});

it("browse(videos) on onedrive calls listVideos, not listMedia", async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'onedrive' });
  onedrive.listVideos.mockResolvedValue({ items: [] });
  const svc = await build();
  await svc.browse('ws', 1, { kind: 'videos' });
  expect(onedrive.listVideos).toHaveBeenCalled();
  expect(onedrive.listMedia).not.toHaveBeenCalled();
});

it("browse(videos) on google_photos calls listVideos, not listMediaItems", async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_photos' });
  photos.listVideos.mockResolvedValue({ mediaItems: [] });
  const svc = await build();
  await svc.browse('ws', 1, { kind: 'videos' });
  expect(photos.listVideos).toHaveBeenCalled();
  expect(photos.listMediaItems).not.toHaveBeenCalled();
});

// FIX 2 — search must exclude folder-shaped matches from items[].

it('dropbox search excludes folder matches from items', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.searchFiles.mockResolvedValue({
    matches: [
      { '.tag': 'folder', id: 'fd', name: 'dir', path_lower: '/dir', path_display: '/dir' },
      { '.tag': 'file', id: 'fl', name: 'a.jpg', path_lower: '/a.jpg', path_display: '/a.jpg', size: 1, media_info: { metadata: { '.tag': 'photo' } } },
    ],
    has_more: false,
  });
  const svc = await build();
  const res = await svc.browse('ws', 1, { kind: 'search', query: 'a' });
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ id: '/a.jpg', name: 'a.jpg' });
});

// FIX 1 — OneDrive cursor must be validated against the Graph API origin to
// prevent SSRF / bearer-token exfiltration via a client-controlled cursor.

it('rejects a malicious OneDrive cursor and never calls the provider', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'onedrive' });
  const svc = await build();
  await expect(
    svc.browse('ws', 1, { kind: 'media', cursor: 'https://attacker.example/x' }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(onedrive.listMedia).not.toHaveBeenCalled();
});

it('rejects a malformed OneDrive cursor and never calls the provider', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'onedrive' });
  const svc = await build();
  await expect(
    svc.browse('ws', 1, { kind: 'media', cursor: 'not a url' }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(onedrive.listMedia).not.toHaveBeenCalled();
});

it('accepts a valid Microsoft Graph OneDrive cursor', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'onedrive' });
  onedrive.listMedia.mockResolvedValue({ items: [] });
  const svc = await build();
  const cursor = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
  await svc.browse('ws', 1, { kind: 'media', cursor });
  expect(onedrive.listMedia).toHaveBeenCalledWith('TKN', {
    folderId: undefined,
    pageSize: undefined,
    nextLink: cursor,
  });
});

it('onedrive search excludes folder matches from items', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'onedrive' });
  onedrive.searchFiles.mockResolvedValue({
    items: [
      { id: 'f', folder: { childCount: 0 }, name: 'dir' },
      { id: 'x', file: { mimeType: 'image/jpeg' }, name: 'a.jpg', size: 1 },
    ],
  });
  const svc = await build();
  const res = await svc.browse('ws', 1, { kind: 'search', query: 'a' });
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ id: 'x', name: 'a.jpg' });
});

// Dropbox is the only provider whose listings carry no thumbnail URL, so the
// mapper leaves `thumbnailUrl` empty and the service must backfill it. Without
// this, every Dropbox file rendered as a "no preview" placeholder.

it('browse(media) on dropbox backfills image thumbnails as data URIs', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listMedia.mockResolvedValue({
    entries: [
      { '.tag': 'file', id: 'i1', name: 'a.jpg', path_lower: '/a.jpg', path_display: '/a.jpg', size: 10, media_info: { metadata: { '.tag': 'photo' } } },
      { '.tag': 'file', id: 'i2', name: 'b.mp4', path_lower: '/b.mp4', path_display: '/b.mp4', size: 20, media_info: { metadata: { '.tag': 'video' } } },
    ],
    cursor: 'C', has_more: false,
  });
  dropbox.getThumbnailBatch.mockResolvedValue(new Map([['/a.jpg', 'data:image/jpeg;base64,AAA']]));

  const svc = await build();
  const res = await svc.browse('ws', 5, { kind: 'media' });

  // Only the image is worth asking Dropbox to thumbnail — it cannot thumbnail video.
  expect(dropbox.getThumbnailBatch).toHaveBeenCalledWith('TKN', ['/a.jpg']);
  expect(res.items[0]).toMatchObject({ id: '/a.jpg', thumbnailUrl: 'data:image/jpeg;base64,AAA' });
  expect(res.items[1]).toMatchObject({ id: '/b.mp4', kind: 'video', thumbnailUrl: '' });
});

it('browse(media) on dropbox still lists files when thumbnails fail', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listMedia.mockResolvedValue({
    entries: [{ '.tag': 'file', id: 'i1', name: 'a.jpg', path_lower: '/a.jpg', path_display: '/a.jpg', size: 10, media_info: { metadata: { '.tag': 'photo' } } }],
    cursor: 'C', has_more: false,
  });
  dropbox.getThumbnailBatch.mockRejectedValue(new Error('dropbox is down'));

  const svc = await build();
  const res = await svc.browse('ws', 5, { kind: 'media' });

  // A missing preview is cosmetic; it must never take the listing down with it.
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ id: '/a.jpg', thumbnailUrl: '' });
});

it('browse(videos) on dropbox asks for no thumbnails at all', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listVideos.mockResolvedValue({
    entries: [{ '.tag': 'file', id: 'i2', name: 'b.mp4', path_lower: '/b.mp4', path_display: '/b.mp4', size: 20, media_info: { metadata: { '.tag': 'video' } } }],
    has_more: false,
  });

  const svc = await build();
  await svc.browse('ws', 5, { kind: 'videos' });

  expect(dropbox.getThumbnailBatch).not.toHaveBeenCalled();
});
