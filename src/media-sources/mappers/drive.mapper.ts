import type { DriveFile, DriveFolder } from '../../channels/services/google-drive.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

// Google Drive's `thumbnailLink` returns a small ~220px image by default
// (e.g. `.../=s220`), which looks blurry when rendered in the picker's larger
// tiles (especially on retina). The size is controlled by the `=s{n}` suffix on
// the googleusercontent URL, so request a higher-resolution thumbnail. If the
// link doesn't carry a size suffix, it's left unchanged.
function upscaleDriveThumbnail(link?: string): string {
  if (!link) return '';
  return link.replace(/=s\d+/, '=s800');
}

export function mapDriveItem(f: DriveFile): CloudMediaItem {
  const isVideo = f.mimeType.startsWith('video/');
  return {
    id: f.id,
    kind: isVideo ? 'video' : 'image',
    name: f.name,
    thumbnailUrl: upscaleDriveThumbnail(f.thumbnailLink),
    sizeBytes: f.size ? Number(f.size) : undefined,
  };
}

export function mapDriveFolder(f: DriveFolder): CloudFolder {
  return { id: f.id, name: f.name, path: f.id };
}
