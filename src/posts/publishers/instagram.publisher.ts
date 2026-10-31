import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  InstagramService,
  InstagramReelSettings,
  InstagramUserTag,
} from '../../channels/services/instagram.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

type InstagramPostType = 'feed' | 'reel' | 'story' | 'carousel';

@Injectable()
export class InstagramPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'instagram';

  constructor(private readonly instagramService: InstagramService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;
    const postType =
      (metadata?.postType as InstagramPostType | undefined) ?? 'feed';

    // Caption length check is global (Stories don't honour captions but the
    // API still accepts the field; we keep the check to surface UX errors).
    if (content && content.length > 2200) {
      throw new Error(
        `Instagram caption exceeds 2200 character limit (${content.length} chars)`,
      );
    }

    switch (postType) {
      case 'reel': {
        if (mediaItems.length === 0) {
          throw new Error('Instagram Reels require a video');
        }
        if (mediaItems[0].type !== 'video') {
          throw new Error('Instagram Reels must be a video');
        }
        break;
      }
      case 'story': {
        if (mediaItems.length === 0) {
          throw new Error('Instagram Stories require an image or video');
        }
        break;
      }
      case 'carousel': {
        if (mediaItems.length < 2 || mediaItems.length > 10) {
          throw new Error(
            'Instagram carousels require between 2 and 10 media items',
          );
        }
        break;
      }
      case 'feed':
      default: {
        if (mediaItems.length === 0) {
          throw new Error(
            'Instagram posts require at least one image or video',
          );
        }
        if (mediaItems.length > 10) {
          throw new Error(
            'Instagram allows maximum 10 media items per carousel',
          );
        }
        break;
      }
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'carousel'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  /**
   * The post-level settings, in Instagram's vocabulary.
   *
   * Everything here is validated rather than forwarded, because the
   * container create fails as a whole: a `location_id` that is not a Page
   * id, a fourth collaborator, or a tag without a username each lose the
   * post rather than the setting.
   */
  private getSettings(
    metadata: Record<string, any> | undefined,
  ): InstagramReelSettings {
    const settings: InstagramReelSettings = {};

    const tags = this.getUserTags(metadata?.userTags);
    if (tags.length > 0) settings.userTags = tags;

    // A PAGE id, not a place name — Meta resolves locations through the
    // Pages Search API, so only something id-shaped can be sent.
    const locationId = metadata?.locationId;
    if (typeof locationId === 'string' && /^\d+$/.test(locationId.trim())) {
      settings.locationId = locationId.trim();
    }

    const collaborators = Array.isArray(metadata?.collaborators)
      ? metadata.collaborators
          .filter((c: unknown): c is string => typeof c === 'string')
          .map((c: string) => c.trim().replace(/^@/, ''))
          .filter(Boolean)
      : [];
    if (collaborators.length > 0) settings.collaborators = collaborators;

    const coverUrl = metadata?.coverUrl;
    if (typeof coverUrl === 'string' && coverUrl.trim()) {
      settings.coverUrl = coverUrl.trim();
    }

    // Only forwarded when the composer actually set it. `false` is a real
    // instruction — it keeps the reel out of the feed — so it must not be
    // invented from an absent value.
    if (typeof metadata?.shareToFeed === 'boolean') {
      settings.shareToFeed = metadata.shareToFeed;
    }

    return settings;
  }

  /** Tags with a usable username, in the order they were given. */
  private getUserTags(raw: unknown): InstagramUserTag[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (t): t is { username: string; x?: number; y?: number } =>
          !!t && typeof t.username === 'string' && !!t.username.trim(),
      )
      .map((t) => ({
        username: t.username,
        x: typeof t.x === 'number' ? t.x : undefined,
        y: typeof t.y === 'number' ? t.y : undefined,
      }));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, metadata } =
      options;

    this.validate(options);

    const postType =
      (metadata?.postType as InstagramPostType | undefined) ?? 'feed';

    // The channels in this app use Instagram Business Login OAuth, which
    // returns an Instagram access token (works against graph.instagram.com),
    // NOT a Facebook Page Access Token. The *WithUserToken variants of
    // InstagramService use the correct graph.instagram.com endpoints.
    // Calling the non-WithUserToken methods (which target graph.facebook.com)
    // results in "Cannot parse access token" (code 190) from Meta.
    let result: { postId: string };

    // Tags live on the MEDIA ITEM — the photo editor writes them there,
    // and Instagram agrees: `user_tags` belongs to the container showing
    // that picture. For a single-media post that is the one item; a
    // carousel reads each slide's own below.
    const settings: InstagramReelSettings = {
      ...this.getSettings(metadata),
      userTags: this.getUserTags(mediaItems[0]?.tags),
    };
    if (settings.userTags?.length === 0) delete settings.userTags;

    if (postType === 'reel') {
      // Reels are always single-video. Validation above guarantees mediaItems[0] is a video.
      result = await this.instagramService.createVideoPostWithUserToken(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        content,
        false,
        'REELS',
        settings,
      );
    } else if (postType === 'story') {
      // Stories can be image OR video, single media only.
      const isVideo = mediaItems[0].type === 'video';
      result = await this.instagramService.createStoryWithUserToken(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        isVideo,
        // A story takes mentions and nothing else here: collaborators are
        // explicitly unsupported on stories, and `share_to_feed` is Reels
        // only.
        settings.userTags,
      );
    } else if (postType === 'carousel') {
      result = await this.instagramService.createCarouselPostWithUserToken(
        platformAccountId,
        accessToken,
        mediaItems.map((m) => ({
          type: m.type === 'video' ? ('VIDEO' as const) : ('IMAGE' as const),
          url: m.url,
          // Per-slide tags; the post-level settings ride the parent.
          userTags: this.getUserTags(m.tags),
        })),
        content,
        settings,
      );
    } else {
      // Default 'feed' routing: mirror legacy behavior (single image/video or
      // implicit carousel when multiple items were provided without an
      // explicit postType from the composer).
      if (mediaItems.length === 1) {
        if (mediaItems[0].type === 'video') {
          result = await this.instagramService.createVideoPostWithUserToken(
            platformAccountId,
            accessToken,
            mediaItems[0].url,
            content,
            false,
            undefined,
            settings,
          );
        } else {
          result = await this.instagramService.createImagePostWithUserToken(
            platformAccountId,
            accessToken,
            mediaItems[0].url,
            content,
            settings,
          );
        }
      } else {
        result = await this.instagramService.createCarouselPostWithUserToken(
          platformAccountId,
          accessToken,
          mediaItems.map((m) => ({
            type: m.type === 'video' ? ('VIDEO' as const) : ('IMAGE' as const),
            url: m.url,
            userTags: this.getUserTags(m.tags),
          })),
          content,
          settings,
        );
      }
    }

    this.logger.log(`Published to Instagram (${postType}): ${result.postId}`);

    const publishResult: PublishResult = {
      platformPostId: result.postId,
    };

    // Story posts cannot receive comments — skip firstComment for Story
    const firstComment =
      typeof metadata?.firstComment === 'string'
        ? metadata.firstComment.trim()
        : '';
    if (firstComment.length > 0 && postType !== 'story') {
      try {
        const comment = await this.instagramService.postCommentWithUserToken(
          accessToken,
          result.postId,
          firstComment,
        );
        this.logger.log(
          `First comment posted on Instagram media ${result.postId}: ${comment.commentId}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentId: comment.commentId,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on Instagram media ${result.postId}: ${reason}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentWarning: reason,
        };
      }
    } else if (firstComment.length > 0 && postType === 'story') {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        firstCommentWarning:
          'Instagram Stories do not support comments — first comment skipped',
      };
    }

    return publishResult;
  }
}
