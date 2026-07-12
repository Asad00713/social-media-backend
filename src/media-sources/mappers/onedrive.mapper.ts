import type { OneDriveItem } from '../../channels/services/onedrive.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

export function mapOneDriveItem(i: OneDriveItem): CloudMediaItem {
  const isVideo = !!i.video;
  return {
    id: i.id,
    kind: isVideo ? 'video' : 'image',
    name: i.name,
    thumbnailUrl: i.thumbnails?.[0]?.large?.url ?? '',
    width: i.video?.width ?? i.image?.width,
    height: i.video?.height ?? i.image?.height,
    durationSec: i.video ? i.video.duration / 1000 : undefined,
    sizeBytes: i.size,
  };
}

export function mapOneDriveFolder(i: OneDriveItem): CloudFolder {
  return { id: i.id, name: i.name, path: i.id };
}
