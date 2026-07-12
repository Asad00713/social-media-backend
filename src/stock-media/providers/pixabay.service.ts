import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface PixabayImage {
  id: number;
  pageURL: string;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
  userImageURL: string;
}

export interface PixabayVideo {
  id: number;
  pageURL: string;
  duration: number;
  user: string;
  picture_id: string;
  videos: {
    large: { url: string; width: number; height: number; thumbnail: string };
    medium: { url: string; width: number; height: number; thumbnail: string };
    small: { url: string; width: number; height: number; thumbnail: string };
    tiny: { url: string; width: number; height: number; thumbnail: string };
  };
}

interface PixabayResponse<T> {
  total: number;
  totalHits: number;
  hits: T[];
}

@Injectable()
export class PixabayService {
  private readonly logger = new Logger(PixabayService.name);
  private readonly apiBaseUrl = 'https://pixabay.com/api';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.PIXABAY_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn(
        'PIXABAY_API_KEY not set - Pixabay integration will not work',
      );
    }
  }

  /**
   * Search for images on Pixabay
   */
  async searchImages(
    q: string,
    page: number,
    perPage: number,
  ): Promise<{ items: PixabayImage[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Pixabay API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('q', q);
    url.searchParams.set('image_type', 'photo');
    url.searchParams.set('safesearch', 'true');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', this.clampPerPage(perPage).toString());

    this.logger.log(`Searching Pixabay images: "${q}" (page ${page})`);

    const data = await this.fetchJson<PixabayImage>(
      url,
      'Failed to fetch Pixabay images',
    );

    return {
      items: data.hits || [],
      hasMore: this.computeHasMore(page, perPage, data.totalHits),
    };
  }

  /**
   * Get popular images on Pixabay
   */
  async popularImages(
    page: number,
    perPage: number,
  ): Promise<{ items: PixabayImage[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Pixabay API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('image_type', 'photo');
    url.searchParams.set('safesearch', 'true');
    url.searchParams.set('order', 'popular');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', this.clampPerPage(perPage).toString());

    this.logger.log(`Fetching popular Pixabay images (page ${page})`);

    const data = await this.fetchJson<PixabayImage>(
      url,
      'Failed to fetch Pixabay popular images',
    );

    return {
      items: data.hits || [],
      hasMore: this.computeHasMore(page, perPage, data.totalHits),
    };
  }

  /**
   * Search for videos on Pixabay
   */
  async searchVideos(
    q: string,
    page: number,
    perPage: number,
  ): Promise<{ items: PixabayVideo[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Pixabay API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/videos/`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('q', q);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', this.clampPerPage(perPage).toString());

    this.logger.log(`Searching Pixabay videos: "${q}" (page ${page})`);

    const data = await this.fetchJson<PixabayVideo>(
      url,
      'Failed to fetch Pixabay videos',
    );

    return {
      items: data.hits || [],
      hasMore: this.computeHasMore(page, perPage, data.totalHits),
    };
  }

  /**
   * Get popular videos on Pixabay
   */
  async popularVideos(
    page: number,
    perPage: number,
  ): Promise<{ items: PixabayVideo[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Pixabay API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/videos/`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('order', 'popular');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', this.clampPerPage(perPage).toString());

    this.logger.log(`Fetching popular Pixabay videos (page ${page})`);

    const data = await this.fetchJson<PixabayVideo>(
      url,
      'Failed to fetch Pixabay popular videos',
    );

    return {
      items: data.hits || [],
      hasMore: this.computeHasMore(page, perPage, data.totalHits),
    };
  }

  private clampPerPage(perPage: number): number {
    return Math.min(Math.max(perPage, 3), 200);
  }

  private computeHasMore(
    page: number,
    perPage: number,
    totalHits: number,
  ): boolean {
    return page * perPage < Math.min(totalHits || 0, 500);
  }

  private async fetchJson<T>(
    url: URL,
    errorMessage: string,
  ): Promise<PixabayResponse<T>> {
    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Pixabay API error: ${response.status} - ${errorText}`);
      throw new BadRequestException(errorMessage);
    }

    return response.json();
  }
}
