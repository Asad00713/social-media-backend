import type { PhotosMediaItem, PhotosAlbum } from '../../channels/services/google-photos.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

export function mapPhotosItem(m: PhotosMediaItem): CloudMediaItem {
  const isVideo = !!m.mediaMetadata.video;
  return {
    id: m.id,
    kind: isVideo ? 'video' : 'image',
    name: m.filename,
    thumbnailUrl: `${m.baseUrl}=w400-h400`,
    width: Number(m.mediaMetadata.width),
    height: Number(m.mediaMetadata.height),
  };
}

export function mapPhotosAlbum(a: PhotosAlbum): CloudFolder {
  return { id: a.id, name: a.title, path: a.id };
}
