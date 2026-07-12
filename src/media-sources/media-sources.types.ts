export type CloudStoragePlatform = 'dropbox' | 'google_drive' | 'onedrive' | 'google_photos';

export type BrowseKind = 'media' | 'images' | 'videos' | 'folders' | 'search';

export interface CloudMediaItem {
  id: string; // provider file/media id (Dropbox: path_lower; Drive/OneDrive/Photos: id)
  kind: 'image' | 'video';
  name: string;
  thumbnailUrl: string; // best available preview; may be a provider URL for display only
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
}

export interface CloudFolder {
  id: string;
  name: string;
  path: string; // Photos: path = albumId
}

export interface CloudBrowseResult {
  items: CloudMediaItem[];
  folders: CloudFolder[];
  nextCursor?: string;
}

export interface CloudImportResult {
  url: string;
  type: 'image' | 'video';
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes: number;
}
