import { mapDropboxItem } from './dropbox.mapper';
import { mapDriveItem } from './drive.mapper';
import { mapOneDriveItem } from './onedrive.mapper';
import { mapPhotosItem, mapPhotosAlbum } from './photos.mapper';

describe('cloud mappers', () => {
  it('maps a Dropbox video with dimensions + duration', () => {
    const item = mapDropboxItem({
      '.tag': 'file', id: 'id:1', name: 'clip.mp4', path_display: '/clip.mp4', path_lower: '/clip.mp4',
      size: 2048, is_downloadable: true, client_modified: '', server_modified: '', rev: 'r',
      media_info: { metadata: { '.tag': 'video', dimensions: { width: 1920, height: 1080 }, duration: 5000 } },
    } as any);
    expect(item).toEqual({ id: '/clip.mp4', kind: 'video', name: 'clip.mp4', thumbnailUrl: '', width: 1920, height: 1080, durationSec: 5, sizeBytes: 2048 });
  });

  it('maps a Drive image', () => {
    const item = mapDriveItem({ id: 'd1', name: 'p.jpg', mimeType: 'image/jpeg', thumbnailLink: 'http://t/p', size: '999' } as any);
    expect(item).toEqual({ id: 'd1', kind: 'image', name: 'p.jpg', thumbnailUrl: 'http://t/p', width: undefined, height: undefined, durationSec: undefined, sizeBytes: 999 });
  });

  it('maps a OneDrive video with duration in ms → seconds', () => {
    const item = mapOneDriveItem({ id: 'o1', name: 'v.mp4', size: 10, video: { width: 640, height: 480, duration: 3000 }, thumbnails: [{ large: { url: 'http://t/o' } }] } as any);
    expect(item).toEqual({ id: 'o1', kind: 'video', name: 'v.mp4', thumbnailUrl: 'http://t/o', width: 640, height: 480, durationSec: 3, sizeBytes: 10 });
  });

  it('maps a Photos item with sized thumbnail url', () => {
    const item = mapPhotosItem({ id: 'g1', baseUrl: 'http://b/g', mimeType: 'image/jpeg', filename: 'g.jpg', mediaMetadata: { creationTime: '', width: '800', height: '600' } } as any);
    expect(item).toEqual({ id: 'g1', kind: 'image', name: 'g.jpg', thumbnailUrl: 'http://b/g=w400-h400', width: 800, height: 600, durationSec: undefined, sizeBytes: undefined });
  });

  it('maps a Photos album to a CloudFolder', () => {
    const f = mapPhotosAlbum({ id: 'a1', title: 'Trip', productUrl: '', mediaItemsCount: '12' } as any);
    expect(f).toEqual({ id: 'a1', name: 'Trip', path: 'a1' });
  });
});
