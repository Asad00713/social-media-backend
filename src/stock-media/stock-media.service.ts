import { BadRequestException, Injectable } from '@nestjs/common';
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
  q: string;
  page: number;
  perPage: number;
}

@Injectable()
export class StockMediaService {
  constructor(
    private readonly unsplash: UnsplashService,
    private readonly pexels: PexelsService,
  ) {}

  async search(params: StockSearchParams): Promise<StockSearchResponse> {
    const { provider, type, q, page, perPage } = params;

    if (provider === 'unsplash') {
      if (type === 'video') {
        throw new BadRequestException('Unsplash does not support video search.');
      }
      const result = await this.unsplash.searchPhotos(q, page, perPage);
      return {
        items: result.results.map(mapUnsplashPhoto),
        page,
        hasMore: page < result.totalPages,
      };
    }

    // provider === 'pexels'
    if (type === 'video') {
      const result = await this.pexels.searchVideos({ query: q, page, perPage });
      return this.fromPexels(result.items.map(mapPexelsVideo), page, result.nextPage);
    }
    const result = await this.pexels.searchPhotos({ query: q, page, perPage });
    return this.fromPexels(result.items.map(mapPexelsPhoto), page, result.nextPage);
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
   * endpoint can't be turned into an open request proxy. Never throws — the
   * ping is best-effort and must not block the user's attach action.
   */
  async track(downloadTriggerUrl: string): Promise<void> {
    let host: string;
    try {
      host = new URL(downloadTriggerUrl).host;
    } catch {
      return;
    }
    if (host !== 'api.unsplash.com') return;
    await this.unsplash.trackDownload(downloadTriggerUrl);
  }
}
