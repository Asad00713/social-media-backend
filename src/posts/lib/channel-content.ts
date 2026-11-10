import type { MediaItem } from '../../drizzle/schema/posts.schema';

/**
 * One channel's caption and media on a STORED post.
 *
 * `posts.platform_content` holds two shapes. The composer stores
 * `{ inheritsFromBase, overrides: { text, mediaItems, … }, platformSpecific }`
 * per platform; older writers stored `{ text, mediaItems }` flat. The
 * scheduled path read only the flat keys, so on a composer post every
 * channel's own caption and media — a variation pick, a "Fit every channel"
 * rewrite, a per-channel file — fell back to the shared post content and
 * went out wrong. Publish-now resolves the same way as here
 * (`PayloadResolverService`): the override when present, else the base.
 *
 * An override is taken as written (`??`, so a channel cleared to "" stays
 * empty, as Publish now does); the legacy keys keep their old `||` fallback.
 */
export function channelContent(
  post: {
    content?: string | null;
    mediaItems?: MediaItem[] | null;
    platformContent?: unknown;
  },
  platform: string,
): { text: string; mediaItems: MediaItem[] } {
  const entry = (
    post.platformContent as Record<string, ChannelEntry> | null | undefined
  )?.[platform];
  const overrides = entry?.overrides;
  return {
    text: overrides?.text ?? (entry?.text || post.content || ''),
    mediaItems:
      overrides?.mediaItems ?? (entry?.mediaItems || post.mediaItems || []),
  };
}

interface ChannelEntry {
  text?: string;
  mediaItems?: MediaItem[];
  overrides?: { text?: string; mediaItems?: MediaItem[] };
}
