import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { TikTokService } from '../../channels/services/tiktok.service';
import { TikTokQuotaService } from '../../channels/services/tiktok-quota.service';
import { TikTokMediaProxyService } from '../../media/tiktok-media-proxy.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { assertTikTokCompliance } from './tiktok-compliance';

@Injectable()
export class TikTokPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'tiktok';

  constructor(
    private readonly tiktokService: TikTokService,
    private readonly tiktokQuotaService: TikTokQuotaService,
    private readonly tiktokMediaProxy: TikTokMediaProxyService,
  ) {
    super();
  }

  /**
   * Translates the composer's frontend TikTokFields shape into the TikTok
   * Direct Post API shape this publisher (and the underlying service) expects.
   *
   * Composer stores fields aligned with TikTok's UX (positive-phrased
   * "allow X" booleans, short privacy slugs, semantic brand labels). The
   * TikTok API uses inverse-phrased "disable X" booleans, full enum values,
   * and toggle-suffixed brand keys. This adapter is the single point where
   * those two shapes meet — keeps the orchestrator / resolver platform-
   * agnostic and the tiktok.service / publish API surface unchanged.
   *
   * Backwards-compatible: if a caller already uses the TikTok-API shape
   * (privacyLevel/disableX/brandContentToggle) those values win.
   */
  private normalizeMetadata(
    raw: Record<string, any> | undefined,
  ): Record<string, any> {
    if (!raw) return {};
    const m = raw;

    const mapPrivacy = (p: unknown): string | undefined => {
      if (typeof p !== 'string') return undefined;
      switch (p) {
        case 'public':
          return 'PUBLIC_TO_EVERYONE';
        case 'friends':
          return 'MUTUAL_FOLLOW_FRIENDS';
        case 'private':
          return 'SELF_ONLY';
        default:
          return undefined;
      }
    };

    const privacyLevel =
      typeof m.privacyLevel === 'string'
        ? m.privacyLevel
        : mapPrivacy(m.privacy);

    // allowX (positive) → disableX (negative). When neither is set, default
    // to "allowed" (matches TikTok's permissive default for missing fields).
    const flip = (allowKey: string, disableKey: string): boolean => {
      if (m[disableKey] !== undefined) return Boolean(m[disableKey]);
      if (m[allowKey] !== undefined) return !m[allowKey];
      return false;
    };

    return {
      ...m,
      privacyLevel,
      disableComment: flip('allowComments', 'disableComment'),
      disableDuet: flip('allowDuet', 'disableDuet'),
      disableStitch: flip('allowStitch', 'disableStitch'),
      brandOrganicToggle:
        m.brandOrganicToggle !== undefined
          ? Boolean(m.brandOrganicToggle)
          : Boolean(m.yourBrand),
      brandContentToggle:
        m.brandContentToggle !== undefined
          ? Boolean(m.brandContentToggle)
          : Boolean(m.brandedContent),
    };
  }

  validate(options: PublishOptions): void {
    const { mediaItems } = options;
    const metadata = this.normalizeMetadata(options.metadata);

    assertTikTokCompliance({
      privacyLevel: metadata.privacyLevel as string | undefined,
      brandContentToggle: metadata.brandContentToggle as boolean | undefined,
      brandOrganicToggle: metadata.brandOrganicToggle as boolean | undefined,
      discloseContent: metadata.discloseContent as boolean | undefined,
    });

    const postType = (metadata.postType as string | undefined) ?? 'video';

    // TikTok requires media (video or images)
    if (mediaItems.length === 0) {
      throw new Error('TikTok posts require media');
    }

    if (postType === 'photo') {
      // Photo mode: 1-35 images
      if (mediaItems.length > 35) {
        throw new Error('TikTok photo posts allow at most 35 images');
      }
      if (!mediaItems.every((m) => m.type === 'image')) {
        throw new Error('TikTok photo posts only accept image media');
      }
    } else if (mediaItems[0].type !== 'video') {
      throw new Error('TikTok only supports video content');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    // TikTok supports videos (single) or images (carousel photo mode)
    if (mediaItems.length === 0) return false;
    const allVideos = mediaItems.every((m) => m.type === 'video');
    const allImages = mediaItems.every((m) => m.type === 'image');
    return allVideos || allImages;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken } = options;
    const metadata = this.normalizeMetadata(options.metadata);

    this.validate(options);

    // Enforce TikTok quota caps (pre-audit user cap + per-creator daily cap)
    // before any publish API call. queryCreatorInfo returns creatorUsername
    // reliably; the response shape doesn't expose open_id directly and the
    // username is unique-per-creator on TikTok so it works as a quota key.
    const creatorInfo = await this.tiktokService.queryCreatorInfo(accessToken);
    const creatorOpenId = creatorInfo.creatorUsername || 'unknown';
    await this.tiktokQuotaService.reserveSlot(creatorOpenId);

    // PULL_FROM_URL flows MUST hand TikTok a URL on our verified domain.
    // We mint a signed token wrapping the original Cloudinary/R2 URL and
    // route through `${proxyBase}/api/tiktok-media/:token`, which streams
    // the upstream bytes through unmodified.
    const proxyBase = process.env.API_PUBLIC_URL ?? 'https://api.schedura.ai';

    const postType = (metadata?.postType as string | undefined) ?? 'video';

    // Get privacy level from metadata, default to SELF_ONLY for safety
    const privacyLevel = metadata?.privacyLevel || 'SELF_ONLY';

    // Photo carousel flow (PULL_FROM_URL)
    if (postType === 'photo') {
      const imageUrls = mediaItems.map((m) => m.url);
      const proxiedImageUrls = imageUrls.map(
        (u) =>
          `${proxyBase}/api/tiktok-media/${this.tiktokMediaProxy.mintProxyToken(u)}`,
      );
      this.logger.log(
        `Publishing TikTok photo carousel: ${imageUrls.length} image(s) via verified-domain proxy`,
      );

      const photoResult = await this.tiktokService.postPhotoFromUrl(
        accessToken,
        proxiedImageUrls,
        {
          description: content || '',
          title: metadata?.title || '',
          privacyLevel,
          disableComment: metadata?.disableComment ?? false,
          brandContentToggle: metadata?.brandContentToggle ?? false,
          brandOrganicToggle: metadata?.brandOrganicToggle ?? false,
        },
      );

      this.logger.log(
        `TikTok photo publish initiated: ${photoResult.publishId}`,
      );

      return {
        platformPostId: photoResult.publishId,
        platformPostUrl: undefined,
        metadata: {
          publishId: photoResult.publishId,
          status: 'processing',
          note: 'Photo carousel is being processed by TikTok. Use the publish status endpoint to check completion.',
        },
      };
    }

    // Video flow (existing)
    const videoItem = mediaItems[0];
    const title = content || metadata?.title || '';
    const useDirectUpload = metadata?.useDirectUpload ?? true; // Default to direct upload for reliability

    this.logger.log(`Publishing TikTok video: ${videoItem.url}`);

    let result: { publishId: string };

    if (useDirectUpload) {
      // Download and upload directly to TikTok (more reliable)
      result = await this.tiktokService.uploadVideoFromUrl(
        accessToken,
        videoItem.url,
        {
          title,
          privacyLevel,
          disableDuet: metadata?.disableDuet ?? false,
          disableStitch: metadata?.disableStitch ?? false,
          disableComment: metadata?.disableComment ?? false,
          videoCoverTimestampMs: metadata?.videoCoverTimestampMs ?? 1000,
          brandContentToggle: metadata?.brandContentToggle ?? false,
          brandOrganicToggle: metadata?.brandOrganicToggle ?? false,
        },
      );
    } else {
      // Let TikTok pull from URL — must be on the verified domain, so wrap
      // the original Cloudinary/R2 URL in a signed proxy token.
      const proxiedVideoUrl = `${proxyBase}/api/tiktok-media/${this.tiktokMediaProxy.mintProxyToken(videoItem.url)}`;
      result = await this.tiktokService.postVideoFromUrl(
        accessToken,
        proxiedVideoUrl,
        {
          title,
          privacyLevel,
          disableDuet: metadata?.disableDuet ?? false,
          disableStitch: metadata?.disableStitch ?? false,
          disableComment: metadata?.disableComment ?? false,
          videoCoverTimestampMs: metadata?.videoCoverTimestampMs ?? 1000,
          brandContentToggle: metadata?.brandContentToggle ?? false,
          brandOrganicToggle: metadata?.brandOrganicToggle ?? false,
        },
      );
    }

    this.logger.log(`TikTok video publish initiated: ${result.publishId}`);

    // Note: TikTok video publishing is asynchronous
    // The publishId can be used to check the status later
    return {
      platformPostId: result.publishId,
      // TikTok doesn't immediately return the video URL
      // The video ID will be available once publishing is complete
      platformPostUrl: undefined,
      metadata: {
        publishId: result.publishId,
        status: 'processing',
        note: 'Use the publish status endpoint to check when the video is ready',
      },
    };
  }
}
