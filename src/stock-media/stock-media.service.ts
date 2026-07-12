import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { PixabayService } from './providers/pixabay.service';
import { GiphyService } from './providers/giphy.service';
import { CoverrService } from './providers/coverr.service';
import { FlickrService } from './providers/flickr.service';
import { mapUnsplashPhoto } from './mappers/unsplash.mapper';
import { mapPexelsPhoto, mapPexelsVideo } from './mappers/pexels.mapper';
import { mapPixabayImage, mapPixabayVideo } from './mappers/pixabay.mapper';
import { mapGiphyGif } from './mappers/giphy.mapper';
import { mapCoverrVideo } from './mappers/coverr.mapper';
import { mapFlickrPhoto, hasUsableUrl } from './mappers/flickr.mapper';
import type {
  StockMediaItem,
  StockMediaType,
  StockProvider,
  StockSearchResponse,
} from './stock-media.types';

export interface StockSearchParams {
  provider: StockProvider;
  type: StockMediaType;
  q?: string;
  page: number;
  perPage: number;
}

/**
 * Which media types each provider can serve. Used to reject impossible
 * provider×type combinations up front (e.g. video from image-only Unsplash,
 * or an image from video-only Coverr) with a clear 400 instead of a confusing
 * empty result or an upstream error.
 */
const PROVIDER_CAPABILITIES: Record<
  StockProvider,
  { image: boolean; video: boolean }
> = {
  unsplash: { image: true, video: false },
  pexels: { image: true, video: true },
  pixabay: { image: true, video: true },
  giphy: { image: true, video: false },
  coverr: { image: false, video: true },
  flickr: { image: true, video: false },
};

@Injectable()
export class StockMediaService {
  private readonly logger = new Logger(StockMediaService.name);

  constructor(
    private readonly unsplash: UnsplashService,
    private readonly pexels: PexelsService,
    private readonly pixabay: PixabayService,
    private readonly giphy: GiphyService,
    private readonly coverr: CoverrService,
    private readonly flickr: FlickrService,
  ) {}

  async search(params: StockSearchParams): Promise<StockSearchResponse> {
    const { provider, type, page, perPage } = params;
    const q = params.q?.trim() ?? '';

    const caps = PROVIDER_CAPABILITIES[provider];
    if (type === 'video' && !caps.video) {
      throw new BadRequestException(
        `${provider} does not support video search.`,
      );
    }
    if (type === 'image' && !caps.image) {
      throw new BadRequestException(
        `${provider} does not support image search.`,
      );
    }

    if (!q) {
      return this.curated(provider, type, page, perPage);
    }

    switch (provider) {
      case 'unsplash': {
        const result = await this.unsplash.searchPhotos(q, page, perPage);
        return {
          items: result.results.map(mapUnsplashPhoto),
          page,
          hasMore: page < result.totalPages,
        };
      }
      case 'pexels': {
        if (type === 'video') {
          const result = await this.pexels.searchVideos({
            query: q,
            page,
            perPage,
          });
          return this.fromPexels(
            result.items.map(mapPexelsVideo),
            page,
            result.nextPage,
          );
        }
        const result = await this.pexels.searchPhotos({
          query: q,
          page,
          perPage,
        });
        return this.fromPexels(
          result.items.map(mapPexelsPhoto),
          page,
          result.nextPage,
        );
      }
      case 'pixabay': {
        if (type === 'video') {
          const { items, hasMore } = await this.pixabay.searchVideos(
            q,
            page,
            perPage,
          );
          return { items: items.map(mapPixabayVideo), page, hasMore };
        }
        const { items, hasMore } = await this.pixabay.searchImages(
          q,
          page,
          perPage,
        );
        return { items: items.map(mapPixabayImage), page, hasMore };
      }
      case 'giphy': {
        const { items, hasMore } = await this.giphy.search(q, page, perPage);
        return { items: items.map(mapGiphyGif), page, hasMore };
      }
      case 'coverr': {
        const { items, hasMore } = await this.coverr.searchVideos(
          q,
          page,
          perPage,
        );
        return { items: items.map(mapCoverrVideo), page, hasMore };
      }
      case 'flickr': {
        const { items, hasMore } = await this.flickr.searchPhotos(
          q,
          page,
          perPage,
        );
        return {
          items: items.filter(hasUsableUrl).map(mapFlickrPhoto),
          page,
          hasMore,
        };
      }
    }
  }

  /**
   * Default/curated feed when no search term is given (like each provider's
   * home): editorial/popular/trending picks. Impossible provider×type combos
   * are already rejected by the caller before this is reached.
   */
  private async curated(
    provider: StockProvider,
    type: StockMediaType,
    page: number,
    perPage: number,
  ): Promise<StockSearchResponse> {
    switch (provider) {
      case 'unsplash': {
        const photos = await this.unsplash.getCuratedPhotos(page, perPage);
        const items = photos.map(mapUnsplashPhoto);
        // Unsplash curated returns a plain array with no total; a full page
        // implies there may be more.
        return { items, page, hasMore: items.length >= perPage };
      }
      case 'pexels': {
        if (type === 'video') {
          const result = await this.pexels.getPopularVideos(page, perPage);
          return this.fromPexels(
            result.items.map(mapPexelsVideo),
            page,
            result.nextPage,
          );
        }
        const result = await this.pexels.getCuratedPhotos(page, perPage);
        return this.fromPexels(
          result.items.map(mapPexelsPhoto),
          page,
          result.nextPage,
        );
      }
      case 'pixabay': {
        if (type === 'video') {
          const { items, hasMore } = await this.pixabay.popularVideos(
            page,
            perPage,
          );
          return { items: items.map(mapPixabayVideo), page, hasMore };
        }
        const { items, hasMore } = await this.pixabay.popularImages(
          page,
          perPage,
        );
        return { items: items.map(mapPixabayImage), page, hasMore };
      }
      case 'giphy': {
        const { items, hasMore } = await this.giphy.trending(page, perPage);
        return { items: items.map(mapGiphyGif), page, hasMore };
      }
      case 'coverr': {
        const { items, hasMore } = await this.coverr.popularVideos(
          page,
          perPage,
        );
        return { items: items.map(mapCoverrVideo), page, hasMore };
      }
      case 'flickr': {
        const { items, hasMore } = await this.flickr.interesting(page, perPage);
        return {
          items: items.filter(hasUsableUrl).map(mapFlickrPhoto),
          page,
          hasMore,
        };
      }
    }
  }

  private fromPexels(
    items: StockMediaItem[],
    page: number,
    nextPage: string | null,
  ): StockSearchResponse {
    return { items, page, hasMore: Boolean(nextPage) };
  }

  /**
   * Fire Unsplash's required download event server-side. Fail-closed: only
   * genuine `api.unsplash.com` download-location URLs are forwarded, so the
   * endpoint can't be turned into an open request proxy. Best-effort ping —
   * any failure (network error, missing Unsplash credentials, etc.) is
   * swallowed and logged so it never blocks or breaks the user's attach
   * action. This method never throws.
   */
  async track(downloadTriggerUrl: string): Promise<void> {
    let host: string;
    try {
      host = new URL(downloadTriggerUrl).host;
    } catch {
      return;
    }
    if (host !== 'api.unsplash.com') return;
    try {
      await this.unsplash.trackDownload(downloadTriggerUrl);
    } catch (error) {
      this.logger.warn(
        `Unsplash download tracking ping failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
