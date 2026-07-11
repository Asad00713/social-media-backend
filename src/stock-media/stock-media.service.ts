import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { mapUnsplashPhoto } from './mappers/unsplash.mapper';
import { mapPexelsPhoto, mapPexelsVideo } from './mappers/pexels.mapper';
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

@Injectable()
export class StockMediaService {
  private readonly logger = new Logger(StockMediaService.name);

  constructor(
    private readonly unsplash: UnsplashService,
    private readonly pexels: PexelsService,
  ) {}

  async search(params: StockSearchParams): Promise<StockSearchResponse> {
    const { provider, type, page, perPage } = params;
    const q = params.q?.trim() ?? '';

    if (provider === 'unsplash' && type === 'video') {
      throw new BadRequestException(
        'Unsplash does not support video search.',
      );
    }

    if (!q) {
      return this.curated(provider, type, page, perPage);
    }

    if (provider === 'unsplash') {
      const result = await this.unsplash.searchPhotos(q, page, perPage);
      return {
        items: result.results.map(mapUnsplashPhoto),
        page,
        hasMore: page < result.totalPages,
      };
    }

    // provider === 'pexels'
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
    const result = await this.pexels.searchPhotos({ query: q, page, perPage });
    return this.fromPexels(
      result.items.map(mapPexelsPhoto),
      page,
      result.nextPage,
    );
  }

  /**
   * Default/curated feed when no search term is given (like Unsplash/Pexels
   * home): Unsplash editorial picks, or Pexels curated photos / popular
   * videos. `provider === 'unsplash' && type === 'video'` is already
   * rejected by the caller before this is reached.
   */
  private async curated(
    provider: StockProvider,
    type: StockMediaType,
    page: number,
    perPage: number,
  ): Promise<StockSearchResponse> {
    if (provider === 'unsplash') {
      const photos = await this.unsplash.getCuratedPhotos(page, perPage);
      const items = photos.map(mapUnsplashPhoto);
      // Unsplash curated returns a plain array with no total; a full page
      // implies there may be more.
      return { items, page, hasMore: items.length >= perPage };
    }
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
