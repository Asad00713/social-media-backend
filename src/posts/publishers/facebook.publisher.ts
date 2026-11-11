import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { readSharedThumbnail } from '../lib/shared-thumbnail';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { findFirstLink, linkCallToActionType } from './facebook-link-cta';
import {
  facebookCollaborator,
  facebookPlace,
  facebookPostOptions,
} from './facebook-post-settings';
import {
  carouselErrors,
  carouselLinks,
  resolveCarouselCards,
  wantsCarousel,
} from './facebook-carousel';

@Injectable()
export class FacebookPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'facebook';

  constructor(private readonly facebookService: FacebookService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems } = options;

    // Facebook allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('Facebook post must have content or media');
    }

    // Check character limit (Facebook allows up to 63,206 chars)
    if (content && content.length > 63206) {
      throw new Error('Facebook content exceeds character limit');
    }

    // A carousel is checked only where it would be sent (a Post with no
    // media): one saved before a photo was attached is left unsent, not
    // refused.
    if (wantsCarousel(options.metadata, mediaItems.length)) {
      const errors = carouselErrors(options.metadata);
      if (errors.length > 0) throw new Error(errors.join('; '));
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, metadata } =
      options;

    this.validate(options);

    const postType = (metadata?.postType as string | undefined) ?? 'post';
    let result: {
      postId: string;
      thumbnailWarning?: string;
      captionsWarning?: string;
    };
    let collaboratorWarning: string | undefined;
    // Settings this kind of post cannot carry, said on the result rather
    // than dropped silently (see posts/lib/publish-warnings.ts).
    let mediaWarning: string | undefined;
    let locationWarning: string | undefined;

    if (postType === 'reel') {
      // Reels require a vertical video. If no media or first is not a video, fail clearly.
      if (mediaItems.length === 0 || mediaItems[0].type !== 'video') {
        throw new Error('Facebook Reels require a vertical video file');
      }
      // `reelTitle` is the draft's own key: `platformSpecific` reaches this
      // publisher as `metadata` verbatim, so the composer writes this name.
      const reelTitle =
        typeof metadata?.reelTitle === 'string'
          ? metadata.reelTitle.trim()
          : '';
      // `thumbnailUrl` is the key YouTube's cover already uses, so the
      // editor's cover tool writes the same name for both.
      const thumbnailUrl =
        typeof metadata?.thumbnailUrl === 'string'
          ? metadata.thumbnailUrl.trim()
          : '';
      const captions = reelCaptions(metadata);
      const place = facebookPlace(metadata);
      result = await this.facebookService.postReelToPage(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        content,
        {
          ...(reelTitle ? { title: reelTitle } : {}),
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...(captions ? { captions } : {}),
          ...(place ? { place } : {}),
        },
      );

      // The Reel is live by now, so an invite that does not go out is a
      // warning on the result - like the cover - not a failed post. A Page
      // cannot invite itself; that choice is dropped rather than sent.
      const collaborator = facebookCollaborator(metadata);
      if (collaborator && collaborator !== platformAccountId) {
        try {
          await this.facebookService.inviteReelCollaborator(
            result.postId,
            accessToken,
            collaborator,
          );
        } catch (err) {
          collaboratorWarning =
            err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Facebook Reel ${result.postId}: collaborator not invited: ${collaboratorWarning}`,
          );
        }
      }
    } else if (postType === 'story') {
      // Stories require exactly one image OR one video.
      if (mediaItems.length === 0) {
        throw new Error('Facebook Stories require 1 photo or video');
      }
      const item = mediaItems[0];
      if (item.type === 'image') {
        result = await this.facebookService.postPhotoStoryToPage(
          platformAccountId,
          accessToken,
          item.url,
        );
      } else if (item.type === 'video') {
        result = await this.facebookService.postVideoStoryToPage(
          platformAccountId,
          accessToken,
          item.url,
        );
      } else {
        throw new Error(
          `Facebook Stories don't support media type: ${item.type}`,
        );
      }
    } else if (mediaItems.length > 0 && mediaItems[0].type === 'video') {
      // A feed VIDEO: `/{page-id}/videos`. It carries YouTube's designed
      // thumbnail when the post has one (`sharedThumbnailUrl`), sent as
      // `thumb`; a picture that cannot be sent is a warning, not a failure.
      // A Reel keeps its own cover frame and never reads this key.
      //
      // Backdate and minimum age are sent (`backdated_post`, `targeting` on
      // the Page Videos reference). Location is not: that edge documents no
      // `place`, so a chosen location is reported as not added.
      const thumbnailUrl = readSharedThumbnail(metadata);
      const { backdatedTime, targeting, place } = facebookPostOptions(metadata);
      result = await this.facebookService.postVideoToPage(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        content,
        {
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...(backdatedTime !== undefined ? { backdatedTime } : {}),
          ...(targeting ? { targeting } : {}),
        },
      );
      if (place) {
        locationWarning =
          'Facebook does not take a location on a feed video, so it was posted without one';
      }
      const leftOut = mediaItems.length - 1;
      if (leftOut > 0) {
        mediaWarning = `Facebook posts a video on its own: published the video, left out ${leftOut} other item${leftOut === 1 ? '' : 's'}`;
      }
    } else if (mediaItems.length > 0 && mediaItems[0].type === 'image') {
      // Every photo, not just the first: one photo is a `/photos` post, two
      // or more a feed post with `attached_media` (postPhotosToPage). A
      // video cannot join them, so one beside the photos is reported.
      const photos = mediaItems
        .filter((m) => m.type === 'image')
        .map((m) => ({ url: m.url, ...altTextField(m) }));
      if (photos.length === 1) {
        result = await this.facebookService.postPhotoToPage(
          platformAccountId,
          accessToken,
          photos[0].url,
          content,
          { ...facebookPostOptions(metadata), ...altTextField(mediaItems[0]) },
        );
      } else {
        result = await this.facebookService.postPhotosToPage(
          platformAccountId,
          accessToken,
          photos,
          content,
          facebookPostOptions(metadata),
        );
      }
      const leftOut = mediaItems.length - photos.length;
      if (leftOut > 0) {
        mediaWarning = `Facebook cannot mix photos and a video in one post: published ${photos.length} photo${photos.length === 1 ? '' : 's'}, left out ${leftOut} other item${leftOut === 1 ? '' : 's'}`;
      }
    } else if (wantsCarousel(metadata, mediaItems.length)) {
      // A link CAROUSEL (`carouselLinks`, validated above). The post's own
      // link is the caption's, which the composer's card is built from; a
      // caption without one falls back to the first card.
      const links = carouselLinks(metadata);
      const cards = await resolveCarouselCards(links);
      result = await this.facebookService.postCarouselToPage(
        platformAccountId,
        accessToken,
        content,
        findFirstLink(content) ?? links[0].url,
        cards,
        facebookPostOptions(metadata),
      );
    } else {
      // A LINK post is text with no media. Its button (`linkCta`, the draft's
      // own key) is sent with the link it belongs to; a link is sent only
      // alongside a button, so a post without one is exactly what it was.
      const link = mediaItems.length === 0 ? findFirstLink(content) : undefined;
      const ctaType = link
        ? linkCallToActionType(metadata?.linkCta)
        : undefined;
      result = await this.facebookService.postToPage(
        platformAccountId,
        accessToken,
        content,
        ctaType ? link : undefined,
        ctaType,
        facebookPostOptions(metadata),
      );
    }

    this.logger.log(`Published to Facebook page: ${result.postId}`);

    const publishResult: PublishResult = {
      platformPostId: result.postId,
      platformPostUrl: `https://facebook.com/${result.postId}`,
    };

    // The Reel (or feed video) is live, so a cover or thumbnail that could
    // not be set is a warning on the result, as a first comment's failure is
    // - not a failed post.
    if (result.thumbnailWarning) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        coverWarning: result.thumbnailWarning,
      };
    }
    // Likewise captions: set after the Reel is live, so a refusal is a warning.
    if (result.captionsWarning) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        captionsWarning: result.captionsWarning,
      };
    }
    if (collaboratorWarning) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        collaboratorWarning,
      };
    }
    if (mediaWarning) {
      this.logger.warn(`Facebook post ${result.postId}: ${mediaWarning}`);
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        mediaWarning,
      };
    }
    if (locationWarning) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        locationWarning,
      };
    }

    // Soft action: post first comment if provided. Failure here is logged
    // and surfaced as a warning — the main post stays "published".
    const firstComment =
      typeof metadata?.firstComment === 'string'
        ? metadata.firstComment.trim()
        : '';
    if (firstComment.length > 0) {
      try {
        const comment = await this.facebookService.postComment(
          platformAccountId,
          accessToken,
          result.postId,
          firstComment,
        );
        this.logger.log(
          `First comment posted on Facebook post ${result.postId}: ${comment.commentId}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentId: comment.commentId,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on Facebook post ${result.postId}: ${reason}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentWarning: reason,
        };
      }
    }

    return publishResult;
  }
}

/**
 * `{ altText }` for a photo that has a description, else nothing - sent as
 * `alt_text_custom` ("Accessible alternative description for an image",
 * Page Photos reference).
 */
function altTextField(item: MediaItem): { altText?: string } {
  const text = typeof item.altText === 'string' ? item.altText.trim() : '';
  return text ? { altText: text } : {};
}

/** The locale a caption file goes out under when the draft names none. */
const DEFAULT_CAPTION_LOCALE = 'en_US';

/**
 * The Reel's caption file, from the draft's own keys - `captionsSrt` (SubRip
 * text, written by the composer's Captions tool) and `captionsLocale` (`en_US`
 * style). Undefined when there is no text, so nothing is sent; a locale that
 * is missing or not of Facebook's shape falls back to `en_US`.
 */
export function reelCaptions(
  metadata: Record<string, unknown> | undefined,
): { srt: string; locale: string } | undefined {
  const srt =
    typeof metadata?.captionsSrt === 'string' ? metadata.captionsSrt : '';
  if (srt.trim() === '') return undefined;
  const locale =
    typeof metadata?.captionsLocale === 'string' &&
    /^[a-z]{2}_[A-Z]{2}$/.test(metadata.captionsLocale)
      ? metadata.captionsLocale
      : DEFAULT_CAPTION_LOCALE;
  return { srt, locale };
}
