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
 * The composer's DRAFT title - the name the person gave the draft in the
 * Planner, not a post title. Every composer write path stores it as the
 * row's shared `metadata.title`, and Pinterest, YouTube, Reddit and TikTok
 * read `metadata.title` as the pin / video / submission title. A scheduled
 * post merges the shared metadata under the channel's own fields, so a
 * channel with no title of its own used to publish under the draft's name,
 * while "Publish now" (which sends only the channel's own fields) sent none.
 */
const DRAFT_TITLE_KEY = 'title';

/**
 * Whether the row was written by the composer, whose `metadata.title` is
 * the draft's name. The scheduler stamps `source: 'composer'`; the draft
 * store and "Publish now" both store the draft's `schedule`. A row from
 * the pre-composer API (`POST /posts`) carries neither, and there
 * `metadata.title` WAS the post title a client sent for YouTube or
 * Pinterest - so it is still handed over.
 */
function isComposerRow(metadata: Record<string, any>): boolean {
  return metadata.source === 'composer' || metadata.schedule !== undefined;
}

/**
 * The post's shared metadata as it may be handed to `platform`'s publisher,
 * before that platform's own `platformSpecific` fields are merged over it.
 *
 * Per-platform keys are dropped for every platform except X, and for X too
 * whenever X has fields of its own (`platformSpecific`): the composer always
 * keeps X's thread and poll there, so a shared copy beside them is at best a
 * duplicate and at worst stale. Only an X target with no fields of its own
 * (a row written before the composer, or by an API client) still reads them.
 *
 * `title` is per-platform too: the composer's shared copy is the draft's
 * name (see DRAFT_TITLE_KEY) and is never handed to a publisher, so a
 * scheduled post gets exactly the title "Publish now" would - the
 * channel's own `platformSpecific.title`, or none. A pre-composer row with
 * no per-platform fields keeps its `metadata.title`.
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
  if (ownFields || isComposerRow(shared)) delete shared[DRAFT_TITLE_KEY];
  return shared;
}
