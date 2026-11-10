/**
 * YouTube's designed thumbnail, shared with the other channels of the post.
 *
 * The composer's thumbnail dialog draws Facebook and LinkedIn as "Same as
 * YouTube": one picture is designed (stored as YouTube's own `thumbnailUrl`)
 * and the channels that take a video thumbnail publish that same picture.
 * There is no second copy on the draft - the picture is read from YouTube's
 * fields at publish time, so it can never go stale against the one the
 * dialog shows, and a post without YouTube shares nothing.
 *
 * It reaches each publisher's `metadata` under its own key,
 * `sharedThumbnailUrl`, never under `thumbnailUrl`: Facebook already reads
 * `thumbnailUrl` as a Reel's cover FRAME, and a 16:9 design must not
 * overwrite a 9:16 cover someone picked.
 */

/** The metadata key a receiving publisher reads. */
export const SHARED_THUMBNAIL_KEY = 'sharedThumbnailUrl';

/**
 * The channels whose publisher sends the shared picture as a video
 * thumbnail. Each decides for itself whether THIS post is a video it can put
 * one on (a Facebook feed video, a LinkedIn video post); this only says who
 * is offered it.
 */
const RECEIVES_SHARED_THUMBNAIL: ReadonlySet<string> = new Set([
  'facebook',
  'linkedin',
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The picture this channel should publish as its video thumbnail, if any.
 *
 * Only YouTube LONG-FORM has one: YouTube takes no custom thumbnail on a
 * Short (`isShort`, the key the YouTube publisher reads), so a picture
 * stored on a Short's fields is not a designed thumbnail of anything.
 *
 * @param platform the channel being published
 * @param platforms every channel the post targets - YouTube must be one,
 *   or a picture left on its fields from before it was removed would be
 *   sent to a post that no longer has it
 * @param perPlatform the post's per-platform content, keyed by platform,
 *   each with its `platformSpecific` fields
 */
export function sharedThumbnailFor(
  platform: string,
  platforms: readonly string[],
  perPlatform: unknown,
): string | undefined {
  if (!RECEIVES_SHARED_THUMBNAIL.has(platform)) return undefined;
  if (!platforms.includes('youtube')) return undefined;

  const youtube = asRecord(
    asRecord(asRecord(perPlatform)?.youtube)?.platformSpecific,
  );
  if (!youtube || youtube.isShort === true) return undefined;

  const url =
    typeof youtube.thumbnailUrl === 'string' ? youtube.thumbnailUrl.trim() : '';
  return url || undefined;
}

/**
 * A publisher's metadata with the shared thumbnail added where this channel
 * gets one; the same object's fields, unchanged, where it does not.
 */
export function withSharedThumbnail<T extends Record<string, unknown>>(
  metadata: T,
  platform: string,
  platforms: readonly string[],
  perPlatform: unknown,
): T & { sharedThumbnailUrl?: string } {
  const url = sharedThumbnailFor(platform, platforms, perPlatform);
  return url ? { ...metadata, [SHARED_THUMBNAIL_KEY]: url } : metadata;
}

/** The shared thumbnail as a publisher receives it, or `undefined`. */
export function readSharedThumbnail(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.[SHARED_THUMBNAIL_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
