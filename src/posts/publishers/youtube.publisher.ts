import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { YouTubeService } from '../../channels/services/youtube.service';
import { YoutubeAuditGateService } from '../../channels/services/youtube-audit-gate.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

// YouTube platform limits — sourced from official Data API v3 docs (May 2026).
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const MIN_VIDEO_DURATION_SEC = 1; // YT rejects sub-second clips
const MAX_VIDEO_DURATION_SEC = 12 * 60 * 60; // 12 hours — standard cap (verified channels can go higher)
const MAX_SHORT_DURATION_SEC = 60; // YouTube Shorts hard cap
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
    if (metadata.title.length > MAX_TITLE_LENGTH) {
      throw new Error(
        `YouTube title cannot exceed ${MAX_TITLE_LENGTH} characters`,
      );
    }

    // Description (combined body + metadata.description)
    const description = options.content || metadata.description || '';
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `YouTube description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }

    // Duration / size guards — only enforced when the media metadata is known.
    // Cloudinary uploads supply `duration` and the orchestrator may pass size
    // through; if a publisher upstream stripped them, we skip the check rather
    // than blocking the publish.
    const isShort = metadata?.isShort === true;
    const duration = media.duration;

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
    const { content, mediaItems, accessToken, metadata, channelId } = options;

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
    let description = content || metadata.description || '';
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
        privacyStatus: metadata.privacyStatus || 'private',
        tags,
        categoryId: metadata.categoryId || '22',
        playlistId: metadata.playlistId,
        madeForKids: metadata.madeForKids || false,
        thumbnailUrl: isShort ? undefined : metadata.thumbnailUrl,
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
 * Idempotent insertion of `#Shorts` at the end of the description.
 * Skips if any case-insensitive `#shorts` tag is already present.
 */
function ensureShortsHashtag(description: string): string {
  if (/#shorts\b/i.test(description)) return description;
  const trimmed = description.trim();
  return trimmed ? `${trimmed}\n\n#Shorts` : '#Shorts';
}
