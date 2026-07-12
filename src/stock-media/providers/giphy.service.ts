import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface GiphyGif {
  id: string;
  url: string; // Giphy page URL
  title: string;
  username: string;
  user?: {
    display_name: string;
    profile_url: string;
  };
  images: {
    original: {
      url: string;
      width: string;
      height: string;
      mp4?: string;
    };
    fixed_width: {
      url: string;
      width: string;
      height: string;
    };
    downsized: {
      url: string;
      width: string;
      height: string;
    };
  };
}

interface GiphyGifsResponse {
  data: GiphyGif[];
  pagination?: {
    total_count?: number;
    count?: number;
    offset?: number;
  };
}

@Injectable()
export class GiphyService {
  private readonly logger = new Logger(GiphyService.name);
  private readonly apiBaseUrl = 'https://api.giphy.com/v1/gifs';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.GIPHY_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn(
        'GIPHY_API_KEY not set - Giphy integration will not work',
      );
    }
  }

  /**
   * Search for GIFs on Giphy
   */
  async search(
    q: string,
    page: number,
    perPage: number,
  ): Promise<{ items: GiphyGif[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Giphy API key not configured');
    }

    const limit = Math.min(Math.max(perPage, 1), 50);
    const offset = (page - 1) * perPage;

    const url = new URL(`${this.apiBaseUrl}/search`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('rating', 'pg-13');
    url.searchParams.set('bundle', 'messaging_non_clips');

    this.logger.log(`Searching Giphy gifs: "${q}" (page ${page})`);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Giphy API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch Giphy gifs');
    }

    const data: GiphyGifsResponse = await response.json();

    return {
      items: data.data || [],
      hasMore: this.computeHasMore(data, limit),
    };
  }

  /**
   * Get trending GIFs on Giphy
   */
  async trending(
    page: number,
    perPage: number,
  ): Promise<{ items: GiphyGif[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Giphy API key not configured');
    }

    const limit = Math.min(Math.max(perPage, 1), 50);
    const offset = (page - 1) * perPage;

    const url = new URL(`${this.apiBaseUrl}/trending`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('rating', 'pg-13');

    this.logger.log(`Fetching trending Giphy gifs (page ${page})`);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Giphy API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch Giphy gifs');
    }

    const data: GiphyGifsResponse = await response.json();

    return {
      items: data.data || [],
      hasMore: this.computeHasMore(data, limit),
    };
  }

  private computeHasMore(data: GiphyGifsResponse, limit: number): boolean {
    const pagination = data.pagination;
    if (pagination?.total_count !== undefined) {
      const offset = pagination.offset ?? 0;
      const count = pagination.count ?? (data.data || []).length;
      return offset + count < pagination.total_count;
    }
    return (data.data || []).length === limit;
  }
}
