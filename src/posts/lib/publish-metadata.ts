/**
 * Keys that describe ONE platform's post and must never reach another
 * platform's publisher from the post's shared `metadata`.
 *
 * Until this fix the composer's schedule path copied X's thread into the
 * row's shared `metadata.thread`. The scheduled publish merges the shared
 * metadata under every channel's own fields, so a Bluesky, Mastodon or
 * Threads channel with no thread of its own published X's thread. Rows
 * scheduled before the fix still hold that copy, so the read side has to
 * refuse it as well as the write side no longer writing it.
 */
export const PER_PLATFORM_METADATA_KEYS = ['thread', 'poll'] as const;

/**
 * The one platform a shared copy was ever written for: the composer lifted
 * X's thread, and a pre-composer API client's `metadata.thread` /
 * `metadata.poll` was read by the X publisher.
 */
const SHARED_COPY_PLATFORM = 'twitter';

/**
 * The post's shared metadata as it may be handed to `platform`'s publisher,
 * before that platform's own `platformSpecific` fields are merged over it.
 *
 * Per-platform keys are dropped for every platform except X, and for X too
 * whenever X has fields of its own (`platformSpecific`): the composer always
 * keeps X's thread and poll there, so a shared copy beside them is at best a
 * duplicate and at worst stale. Only an X target with no fields of its own
 * (a row written before the composer, or by an API client) still reads them.
 */
export function sharedMetadataFor(
  postMetadata: Record<string, any> | null | undefined,
  platform: string,
  ownFields: Record<string, any> | null | undefined,
): Record<string, any> {
  const shared: Record<string, any> = { ...(postMetadata ?? {}) };
  const keepSharedCopy = platform === SHARED_COPY_PLATFORM && !ownFields;
  if (!keepSharedCopy) {
    for (const key of PER_PLATFORM_METADATA_KEYS) delete shared[key];
  }
  return shared;
}
