import type { DropboxFile, DropboxFolder } from '../../channels/services/dropbox.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

export function mapDropboxItem(e: DropboxFile): CloudMediaItem {
  const meta = e.media_info?.metadata;
  const isVideo = meta?.['.tag'] === 'video';
  return {
    id: e.path_lower,
    kind: isVideo ? 'video' : 'image',
    name: e.name,
    thumbnailUrl: '',
    width: meta?.dimensions?.width,
    height: meta?.dimensions?.height,
    durationSec: meta?.duration != null ? meta.duration / 1000 : undefined,
    sizeBytes: e.size,
  };
}

export function mapDropboxFolder(f: DropboxFolder): CloudFolder {
  return { id: f.path_lower, name: f.name, path: f.path_lower };
}
