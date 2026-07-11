import type { DriveFile, DriveFolder } from '../../channels/services/google-drive.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

export function mapDriveItem(f: DriveFile): CloudMediaItem {
  const isVideo = f.mimeType.startsWith('video/');
  return {
    id: f.id,
    kind: isVideo ? 'video' : 'image',
    name: f.name,
    thumbnailUrl: f.thumbnailLink ?? '',
    sizeBytes: f.size ? Number(f.size) : undefined,
  };
}

export function mapDriveFolder(f: DriveFolder): CloudFolder {
  return { id: f.id, name: f.name, path: f.id };
}
