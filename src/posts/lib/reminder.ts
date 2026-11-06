import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/**
 * "Publish: Automatically | Remind me" — Figma's Instagram and Facebook
 * inspectors. In reminder mode we do NOT call the platform: at the post's
 * time the person gets a notification with everything copied (caption, media
 * links, the Story's frame note) and posts it by hand, which is how music,
 * stickers and link taps — things no API accepts — get onto a post.
 *
 * The draft key is `platformSpecific.publishMode`, the only value acted on
 * is `'remind'`; anything else (or nothing) publishes automatically, exactly
 * as before.
 */
export const REMINDER_PLATFORMS: readonly SupportedPlatform[] = [
  'instagram',
  'facebook',
];

export const REMIND_MODE = 'remind';

/**
 * A reminder target counts as done for the post's status: it is stored as
 * `published` with `reminderSentAt` and no platform id, because the person
 * was handed everything to post it. One constant, so it can change in a line.
 */
export const REMINDER_TARGET_STATUS = 'published' as const;

const PLATFORM_NAMES: Partial<Record<SupportedPlatform, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
};

/** Keep the notification readable; the full caption is in the post itself. */
export const REMINDER_CAPTION_MAX = 2000;

type Loose = Record<string, unknown> | undefined | null;

type Media = Array<{ url?: string }>;

/**
 * One platform's entry in posts.platform_content. The composer writes
 * `{ overrides: { text, mediaItems }, platformSpecific }`; older rows carry
 * `text` / `mediaItems` at the top. Both are read.
 */
interface PlatformEntry {
  text?: string;
  mediaItems?: Media;
  overrides?: { text?: string; mediaItems?: Media };
  platformSpecific?: { publishMode?: unknown; frameNote?: unknown };
}

/** The per-platform settings of a stored post, whatever shape they took. */
function platformEntry(
  platformContent: Loose,
  platform: string,
): PlatformEntry | undefined {
  return (platformContent ?? {})[platform] as PlatformEntry | undefined;
}

/** Whether this channel of the post is a reminder rather than a publish. */
export function isReminderTarget(
  platform: string,
  platformContent: Loose,
): boolean {
  if (!REMINDER_PLATFORMS.includes(platform as SupportedPlatform)) {
    return false;
  }
  const entry = platformEntry(platformContent, platform);
  return entry?.platformSpecific?.publishMode === REMIND_MODE;
}

export interface ReminderContent {
  platform: string;
  caption: string;
  mediaUrls: string[];
  /** Instagram Story's "Frame note · only in your reminder". */
  note?: string;
}

/**
 * What the reminder carries for one channel: the caption and media that
 * channel would have published (its own edit when it has one), and its note.
 */
export function reminderContent(
  platform: string,
  post: {
    content?: string | null;
    mediaItems?: Array<{ url?: string }> | null;
    platformContent?: Loose;
  },
): ReminderContent {
  const entry = platformEntry(post.platformContent, platform);
  const caption: string =
    entry?.overrides?.text ?? entry?.text ?? post.content ?? '';
  const media: Media =
    entry?.overrides?.mediaItems ?? entry?.mediaItems ?? post.mediaItems ?? [];
  const note = entry?.platformSpecific?.frameNote;
  return {
    platform,
    caption,
    mediaUrls: media
      .map((m) => m?.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0),
    ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
  };
}

/** The notification's title and body. */
export function reminderText(c: ReminderContent): {
  title: string;
  message: string;
} {
  const name = PLATFORM_NAMES[c.platform as SupportedPlatform] ?? c.platform;
  const caption =
    c.caption.length > REMINDER_CAPTION_MAX
      ? `${c.caption.slice(0, REMINDER_CAPTION_MAX - 1)}…`
      : c.caption;
  const parts: string[] = [];
  if (c.note) parts.push(`Note: ${c.note}`);
  if (caption) parts.push(caption);
  if (c.mediaUrls.length) parts.push(`Media:\n${c.mediaUrls.join('\n')}`);
  return {
    title: `Time to post on ${name}`,
    message: parts.join('\n\n') || `Your ${name} post is ready to go out.`,
  };
}
