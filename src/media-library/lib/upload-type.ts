import type { MediaType } from './folder-kind';

/** What Cloudinary says about a stored upload, enough to type the item. */
export interface UploadTypeHints {
  resourceType: 'image' | 'video' | 'raw';
  format?: string;
  mimeType?: string;
}

/**
 * The Library type of an upload. Cloudinary stores GIFs and PDFs as images,
 * so the format (or the browser's mime type) decides those two first.
 */
export function mediaTypeFromUpload(u: UploadTypeHints): MediaType {
  const format = u.format?.toLowerCase();
  if (format === 'gif' || u.mimeType === 'image/gif') return 'gif';
  if (format === 'pdf' || u.resourceType === 'raw') return 'document';
  if (u.resourceType === 'video') return 'video';
  return 'image';
}
