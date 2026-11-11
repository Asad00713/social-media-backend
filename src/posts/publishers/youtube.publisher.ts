import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { YouTubeService } from '../../channels/services/youtube.service';
import { YoutubeAuditGateService } from '../../channels/services/youtube-audit-gate.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

import { utf8Bytes, youtubeTagsLength } from './text-length';

// YouTube platform limits — Data API v3 `videos` resource.
const MAX_TITLE_LENGTH = 100;
/** "a maximum length of 5000 bytes" - bytes, not characters. */
const MAX_DESCRIPTION_BYTES = 5000;
/** All tags together, counted YouTube's way. */
const MAX_TAGS_LENGTH = 500;
const MIN_VIDEO_DURATION_SEC = 1; // YT rejects sub-second clips
const MAX_VIDEO_DURATION_SEC = 12 * 60 * 60; // 12 hours — standard cap (verified channels can go higher)
/**
 * Three minutes: "square or vertical aspect ratio up to three minutes in
 * length will be categorized as Shorts" (support.google.com/youtube/answer/
 * 15424877). The composer's `SHORT_MAX_DURATION_SEC` is the same 180.
 */
const MAX_SHORT_DURATION_SEC = 180;
const MAX_VIDEO_SIZE_BYTES = 256 * 1024 * 1024 * 1024; // 256 GB standard

@Injectable()
export class YouTubePublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'youtube';

  constructor(
    private readonly youtubeService: YouTubeService,
    private readonly auditGate: YoutubeAuditGateService,
  ) {
    super();
  }

  validate(options: PublishOptions): void {
    const { mediaItems, metadata } = options;

    // YouTube requires a video
    if (mediaItems.length === 0) {
      throw new Error('YouTube posts require a video');
    }
    if (mediaItems.length > 1) {
      throw new Error('YouTube accepts only one video per post');
    }

    const media = mediaItems[0];
    if (media.type !== 'video') {
      throw new Error('YouTube only supports video content');
    }

    // Title is required
    if (!metadata?.title?.trim()) {
      throw new Error('YouTube videos require a title');
    }
    if (Array.from(metadata.title as string).length > MAX_TITLE_LENGTH) {
      throw new Error(
        `YouTube title cannot exceed ${MAX_TITLE_LENGTH} characters`,
      );
    }

    const isShort = metadata?.isShort === true;

    // The description the YouTube card shows - never the shared caption -
    // as it will be SENT (a Short gains `#Shorts`). Its limit is "5000
    // bytes", not characters (Data API `videos`): an emoji spends 4.
    const description = isShort
      ? ensureShortsHashtag(youtubeDescription(metadata))
      : youtubeDescription(metadata);
    const descriptionBytes = utf8Bytes(description);
    if (descriptionBytes > MAX_DESCRIPTION_BYTES) {
      throw new Error(
        `YouTube description cannot exceed ${MAX_DESCRIPTION_BYTES} bytes (${descriptionBytes} given)`,
      );
    }
    // "may contain all valid UTF-8 characters except < and >" - both fields.
    if (/[<>]/.test(metadata.title) || /[<>]/.test(description)) {
      throw new Error(
        'YouTube does not allow < or > in the title or description',
      );
    }
    // Tags: 500 characters in all, counted YouTube's way (commas count; a
    // tag with a space counts its quotes).
    const tags = Array.isArray(metadata.tags)
      ? (metadata.tags as unknown[]).filter(
          (t): t is string => typeof t === 'string',
        )
      : [];
    const tagsLength = youtubeTagsLength(tags);
    if (tagsLength > MAX_TAGS_LENGTH) {
      throw new Error(
        `YouTube tags cannot exceed ${MAX_TAGS_LENGTH} characters (${tagsLength} given)`,
      );
    }

    // Duration / size guards — only enforced when the media metadata is known.
    // The composer stores the probed length as `durationSec`; older rows and
    // Cloudinary uploads carry `duration`. Reading only `duration` meant the
    // Shorts limit below never ran on a composer post.
    const duration =
      typeof media.duration === 'number'
        ? media.duration
        : (media as MediaItem & { durationSec?: number }).durationSec;

    if (typeof duration === 'number') {
      if (duration < MIN_VIDEO_DURATION_SEC) {
        throw new Error('Video is too short to publish to YouTube');
      }
      if (isShort && duration > MAX_SHORT_DURATION_SEC) {
        throw new Error(
          `YouTube Shorts must be ${MAX_SHORT_DURATION_SEC} seconds or less (got ${Math.round(duration)}s). Switch to long-form, or trim the video.`,
        );
      }
      if (!isShort && duration > MAX_VIDEO_DURATION_SEC) {
        throw new Error(
          `YouTube videos must be under 12 hours (got ${Math.round(duration / 60)} min)`,
        );
      }
    }

    // Aspect ratio sanity-check for Shorts — must be vertical (height >= width).
    if (
      isShort &&
      typeof media.width === 'number' &&
      typeof media.height === 'number' &&
      media.height < media.width
    ) {
      throw new Error(
        'YouTube Shorts must be vertical (9:16). The current video is landscape — re-export it portrait or publish as a long-form video instead.',
      );
    }

    // File-size guard (best-effort — only applied when we have a size).
    const sizeBytes =
      (media as MediaItem & { sizeBytes?: number; size?: number }).sizeBytes ??
      (media as MediaItem & { sizeBytes?: number; size?: number }).size;
    if (typeof sizeBytes === 'number' && sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new Error(
        `Video file exceeds YouTube's 256 GB upload limit (${Math.round(sizeBytes / 1024 / 1024 / 1024)} GB)`,
      );
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.every((m) => m.type === 'video');
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { mediaItems, accessToken, metadata, channelId } = options;

    this.validate(options);

    // Pre-audit + per-channel upload caps. Throws 429 when either is hit;
    // reserving BEFORE any upload work begins (queryCreatorInfo-equivalent
    // work / videos.insert) avoids burning a quota-metered API call on a
    // request we are about to refuse.
    await this.auditGate.reserveUpload(channelId);

    const isShort = metadata?.isShort === true;

    // Compose description. For Shorts, ensure #Shorts is present — YouTube
    // auto-classifies vertical videos < 60s as Shorts, but having the hashtag
    // in the description boosts discoverability and is what the official
    // guidance recommends.
    let description = youtubeDescription(metadata);
    if (isShort) {
      description = ensureShortsHashtag(description);
    }

    // Tags — auto-append "Shorts" tag for Shorts so the official Shorts
    // surface picks them up reliably.
    const tags: string[] = [...(metadata.tags || [])];
    if (isShort && !tags.some((t) => /^shorts$/i.test(t))) {
      tags.push('Shorts');
    }

    const result = await this.youtubeService.uploadVideoFromUrl(
      accessToken,
      mediaItems[0].url,
      {
        title: metadata.title,
        description,
        privacyStatus: youtubePrivacyStatus(metadata.privacyStatus),
        tags,
        categoryId: metadata.categoryId || '22',
        playlistId: metadata.playlistId,
        madeForKids: metadata.madeForKids || false,
        thumbnailUrl: isShort ? undefined : metadata.thumbnailUrl,
        defaultLanguage:
          typeof metadata.language === 'string' && metadata.language.trim()
            ? metadata.language.trim()
            : undefined,
        containsSyntheticMedia: metadata.alteredContent === true,
        // YouTube notifies subscribers by DEFAULT, so this is only sent to
        // turn it off. Forwarding `true` would be a no-op, and forwarding
        // an unset switch as `false` would silence a notification nobody
        // asked to silence.
        notifySubscribers:
          metadata.notifySubscribers === false ? false : undefined,
      },
    );

    this.logger.log(
      `Published to YouTube ${isShort ? '(Short)' : '(long-form)'}: ${result.videoId}`,
    );

    const publishResult: PublishResult = {
      platformPostId: result.videoId,
      platformPostUrl: result.videoUrl,
    };

    const firstComment =
      typeof metadata?.firstComment === 'string'
        ? metadata.firstComment.trim()
        : '';
    const allowComments = metadata?.allowComments !== false; // default true
    if (firstComment.length > 0 && allowComments) {
      try {
        const comment = await this.youtubeService.postComment(
          accessToken,
          result.videoId,
          firstComment,
        );
        this.logger.log(
          `First comment posted on YouTube video ${result.videoId}: ${comment.commentId}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentId: comment.commentId,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on YouTube video ${result.videoId}: ${reason}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentWarning: reason,
        };
      }
    } else if (firstComment.length > 0 && !allowComments) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        firstCommentWarning:
          'Comments are disabled on this video — first comment skipped',
      };
    }

    return publishResult;
  }
}

/**
 * The visibility a video is uploaded with when the draft names none.
 *
 * `public`, because that is what the composer's Visibility row shows before
 * anyone touches it (`youtube-inspector.tsx`). The composer now stores the
 * value explicitly; this default only decides drafts saved before it did,
 * and those were shown as Public too. One default on both sides, so the
 * row never reads Public over a video that uploads Private.
 */
export const YOUTUBE_DEFAULT_PRIVACY = 'public';

const YOUTUBE_PRIVACY_VALUES = new Set(['public', 'unlisted', 'private']);

/** The draft's visibility, or the shared default when it is missing or unknown. */
export function youtubePrivacyStatus(
  value: unknown,
): 'public' | 'unlisted' | 'private' {
  return typeof value === 'string' && YOUTUBE_PRIVACY_VALUES.has(value)
    ? (value as 'public' | 'unlisted' | 'private')
    : YOUTUBE_DEFAULT_PRIVACY;
}

/**
 * The video's description: the YouTube card's own Description field.
 *
 * Never the shared caption (`content`). The YouTube card has no caption -
 * it draws a title and a description, and its counter measures the
 * description - so the shared caption is text the person never saw on this
 * channel. Sending it as the description put words on the video that the
 * composer showed nowhere, and ignored the description that was typed.
 */
export function youtubeDescription(
  metadata: Record<string, unknown> | undefined,
): string {
  const value = metadata?.description;
  return typeof value === 'string' ? value : '';
}

/**
 * Idempotent insertion of `#Shorts` at the end of the description.
 * Skips if any case-insensitive `#shorts` tag is already present.
 */
function ensureShortsHashtag(description: string): string {
  if (/#shorts\b/i.test(description)) return description;
  const trimmed = description.trim();
  return trimmed ? `${trimmed}\n\n#Shorts` : '#Shorts';
}
