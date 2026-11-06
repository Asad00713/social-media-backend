import type {
  BaseContent,
  ChannelTarget,
  PlatformOverrides,
} from '../types/draft.types';

/** `post_history.action` of a content snapshot. */
export const VERSION_ACTION = 'content_saved';
/** Snapshots kept per post; older ones are pruned on the next save. */
export const MAX_VERSIONS = 50;
/** Longest caption excerpt a "Changed the caption" line quotes. */
export const EXCERPT_MAX = 40;

/**
 * What a version holds: the post's content as it was saved. Not its
 * schedule, status or per-channel publish results — restoring a version
 * brings back what was written, never when or whether it went out.
 */
export interface DraftSnapshot {
  text: string;
  mediaItems: BaseContent['mediaItems'];
  hashtags: string[];
  mentions: BaseContent['mentions'];
  linkPreview?: BaseContent['linkPreview'];
  perPlatform: PlatformOverrides;
  channels: Array<Pick<ChannelTarget, 'channelId' | 'platform'>>;
  title?: string;
}

/** "photo" when every item involved is an image, "video" when every one is a video. */
export type MediaNoun = 'photo' | 'video' | 'file';

/** What a version changed, worded by the client. */
export type VersionChange =
  | { kind: 'created' }
  | { kind: 'restored'; fromAt: string }
  | { kind: 'caption'; excerpt: string }
  | { kind: 'media_added'; count: number; noun: MediaNoun }
  | { kind: 'media_removed'; count: number; noun: MediaNoun }
  | { kind: 'channels' }
  | { kind: 'edited' };

/** `post_history.details` of a snapshot row. */
export interface VersionDetails {
  snapshot: DraftSnapshot;
  change: VersionChange;
}

export function snapshotOf(input: {
  base: BaseContent;
  perPlatform?: PlatformOverrides;
  channels?: ChannelTarget[];
  title?: string;
}): DraftSnapshot {
  const snap: DraftSnapshot = {
    text: input.base?.text ?? '',
    mediaItems: input.base?.mediaItems ?? [],
    hashtags: input.base?.hashtags ?? [],
    mentions: input.base?.mentions ?? [],
    perPlatform: input.perPlatform ?? {},
    channels: (input.channels ?? []).map((c) => ({
      channelId: c.channelId,
      platform: c.platform,
    })),
  };
  if (input.base?.linkPreview) snap.linkPreview = input.base.linkPreview;
  if (input.title) snap.title = input.title;
  return snap;
}

/**
 * JSON with keys sorted at every level. `jsonb` does not keep key order, so
 * a snapshot read back from Postgres must compare equal to the same content
 * built in memory.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, o[k]]),
      );
    }
    return v;
  });
}

export function sameSnapshot(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return stableStringify(a) === stableStringify(b);
}

function nounOf(items: DraftSnapshot['mediaItems']): MediaNoun {
  if (items.every((m) => m.type === 'image')) return 'photo';
  if (items.every((m) => m.type === 'video')) return 'video';
  return 'file';
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX
    ? `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`
    : flat;
}

/**
 * The one change a version line names, in order of what a person notices:
 * the caption, then the media, then the channels, then "edited".
 */
export function describeChange(
  prev: DraftSnapshot | null,
  next: DraftSnapshot,
): VersionChange {
  if (!prev) return { kind: 'created' };
  if (prev.text !== next.text) {
    return { kind: 'caption', excerpt: excerpt(next.text) };
  }
  // By id, not by count: swapping one photo for another is a change too.
  const prevIds = new Set(prev.mediaItems.map((m) => m.id));
  const nextIds = new Set(next.mediaItems.map((m) => m.id));
  const added = next.mediaItems.filter((m) => !prevIds.has(m.id));
  const removed = prev.mediaItems.filter((m) => !nextIds.has(m.id));
  if (added.length > 0) {
    return { kind: 'media_added', count: added.length, noun: nounOf(added) };
  }
  if (removed.length > 0) {
    return {
      kind: 'media_removed',
      count: removed.length,
      noun: nounOf(removed),
    };
  }
  const ids = (s: DraftSnapshot) =>
    s.channels
      .map((c) => String(c.channelId))
      .sort()
      .join(',');
  if (ids(prev) !== ids(next)) return { kind: 'channels' };
  return { kind: 'edited' };
}

/** A stored row's details, or null when it is not a usable snapshot. */
export function readVersion(details: unknown): VersionDetails | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Partial<VersionDetails>;
  if (!d.snapshot || typeof d.snapshot !== 'object') return null;
  if (!d.change || typeof d.change !== 'object') return null;
  return d as VersionDetails;
}
