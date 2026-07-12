import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface FlickrPhoto {
  id: string;
  owner: string;
  ownername: string;
  title: string;
  license: string;
  url_l?: string;
  width_l?: number;
  height_l?: number;
  url_m?: string;
  width_m?: number;
  height_m?: number;
}

interface FlickrPhotosResponse {
  stat: string;
  photos?: {
    page: number;
    pages: number;
    perpage: number;
    total: number;
    photo: FlickrPhoto[];
  };
  message?: string;
}

/**
 * Commercial-safe Flickr license ids (per https://www.flickr.com/services/api/flickr.photos.licenses.getInfo.htm):
 *  4  = Attribution License (CC BY 2.0)
 *  5  = Attribution-ShareAlike License (CC BY-SA 2.0)
 *  7  = No known copyright restrictions
 *  9  = Public Domain Dedication (CC0)
 *  10 = Public Domain Mark
 * NC (NonCommercial) and ND (NoDerivs) licenses are deliberately excluded.
 */
const COMMERCIAL_LICENSES = '4,5,7,9,10';

@Injectable()
export class FlickrService {
  private readonly logger = new Logger(FlickrService.name);
  private readonly apiBaseUrl = 'https://api.flickr.com/services/rest/';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.FLICKR_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn(
        'FLICKR_API_KEY not set - Flickr integration will not work',
      );
    }
  }

  /**
   * Search for Creative-Commons-friendly, commercial-safe photos on Flickr
   */
  async searchPhotos(
    q: string,
    page: number,
    perPage: number,
  ): Promise<{ items: FlickrPhoto[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Flickr API key not configured');
    }

    const url = this.buildBaseUrl('flickr.photos.search', page, perPage);
    url.searchParams.set('text', q);
    url.searchParams.set('license', COMMERCIAL_LICENSES);
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('content_type', '1');
    url.searchParams.set('media', 'photos');

    this.logger.log(`Searching Flickr photos: "${q}" (page ${page})`);

    const data = await this.fetchJson(url, 'Failed to fetch Flickr photos');

    return {
      items: data.photos?.photo || [],
      hasMore: this.computeHasMore(data),
    };
  }

  /**
   * Browse feed with no search query. Tries the license-filtered
   * "interestingness-desc" sort on flickr.photos.search first; if Flickr
   * rejects an empty `text` value, falls back to
   * flickr.interestingness.getList (not license-filtered).
   */
  async interesting(
    page: number,
    perPage: number,
  ): Promise<{ items: FlickrPhoto[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Flickr API key not configured');
    }

    const url = this.buildBaseUrl('flickr.photos.search', page, perPage);
    url.searchParams.set('license', COMMERCIAL_LICENSES);
    url.searchParams.set('sort', 'interestingness-desc');
    url.searchParams.set('content_type', '1');
    url.searchParams.set('media', 'photos');

    this.logger.log(`Fetching interesting Flickr photos (page ${page})`);

    const data = await this.fetchJsonAllowError(url);

    if (data.stat === 'ok') {
      return {
        items: data.photos?.photo || [],
        hasMore: this.computeHasMore(data),
      };
    }

    this.logger.warn(
      `flickr.photos.search rejected empty text (${data.message || 'unknown error'}); ` +
        'falling back to flickr.interestingness.getList',
    );

    const fallbackUrl = this.buildBaseUrl(
      'flickr.interestingness.getList',
      page,
      perPage,
    );

    const fallbackData = await this.fetchJson(
      fallbackUrl,
      'Failed to fetch Flickr photos',
    );

    return {
      items: fallbackData.photos?.photo || [],
      hasMore: this.computeHasMore(fallbackData),
    };
  }

  private buildBaseUrl(method: string, page: number, perPage: number): URL {
    const url = new URL(this.apiBaseUrl);
    url.searchParams.set('method', method);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('nojsoncallback', '1');
    url.searchParams.set('extras', 'url_l,url_m,owner_name,license');
    url.searchParams.set('per_page', this.clampPerPage(perPage).toString());
    url.searchParams.set('page', page.toString());
    return url;
  }

  private clampPerPage(perPage: number): number {
    return Math.min(Math.max(perPage, 1), 500);
  }

  private computeHasMore(data: FlickrPhotosResponse): boolean {
    if (!data.photos) return false;
    return data.photos.page < data.photos.pages;
  }

  private async fetchJsonAllowError(url: URL): Promise<FlickrPhotosResponse> {
    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Flickr API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch Flickr photos');
    }

    return response.json();
  }

  private async fetchJson(
    url: URL,
    errorMessage: string,
  ): Promise<FlickrPhotosResponse> {
    const data = await this.fetchJsonAllowError(url);

    if (data.stat !== 'ok') {
      this.logger.error(`Flickr API error: ${data.message || 'unknown error'}`);
      throw new BadRequestException(errorMessage);
    }

    return data;
  }
}
