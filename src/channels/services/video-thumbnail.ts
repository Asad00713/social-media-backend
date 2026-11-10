import { fetchPublicMedia } from '../../common/net/public-fetch';

/**
 * The largest video thumbnail we will download and forward.
 *
 * Neither Facebook's `thumb` parameter nor LinkedIn's thumbnail upload states
 * a limit; Facebook's `/{video-id}/thumbnails` edge says 10 MB, so the same
 * cap is used for both (INFERRED to be safe). The picture is YouTube's
 * thumbnail, which YouTube itself caps at 2 MB, so a real one is far below it.
 */
export const MAX_VIDEO_THUMBNAIL_BYTES = 10 * 1024 * 1024;

/** A downloaded thumbnail, ready to forward as a file. */
export interface VideoThumbnail {
  bytes: ArrayBuffer;
  /** The image's own type, as the host served it. */
  contentType: string;
}

/**
 * Downloads a video thumbnail from a draft-supplied URL.
 *
 * Always through `fetchPublicMedia`, the SSRF guard: the URL comes from the
 * draft, so it is fetched only from a public host, with DNS pinned, redirects
 * re-checked hop by hop and the body capped.
 *
 * Throws an `Error` whose message says why in words a person can act on. The
 * callers catch it and publish the video WITHOUT a thumbnail, returning the
 * message as a warning: a thumbnail is decoration, the video is the post.
 */
export async function downloadVideoThumbnail(
  url: string,
): Promise<VideoThumbnail> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('the thumbnail is not a web (http or https) address');
  }

  let response: Response;
  try {
    response = await fetchPublicMedia(url, {
      maxBytes: MAX_VIDEO_THUMBNAIL_BYTES,
    });
  } catch (err) {
    throw new Error(
      `the thumbnail could not be downloaded (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `the thumbnail could not be downloaded (HTTP ${response.status})`,
    );
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  // A host that names no type is given the benefit of the doubt (the
  // platform will refuse a non-image itself); one that names a non-image
  // type is not - sending an HTML error page as a picture fails the upload.
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`the thumbnail is not an image (${contentType})`);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (err) {
    throw new Error(
      `the thumbnail could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (bytes.byteLength === 0) throw new Error('the thumbnail is empty');
  if (bytes.byteLength > MAX_VIDEO_THUMBNAIL_BYTES) {
    throw new Error('the thumbnail is over 10 MB');
  }

  return { bytes, contentType: contentType || 'image/jpeg' };
}
