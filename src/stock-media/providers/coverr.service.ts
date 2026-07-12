import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface CoverrVideo {
  id: string | number;
  title?: string;
  urls?: {
    mp4?: string;
    mp4_download?: string;
    mp4_preview?: string;
    poster?: string;
    thumbnail?: string;
  };
  poster?: string;
  thumbnail?: string;
  max_width?: number;
  max_height?: number;
  info?: {
    width?: number;
    height?: number;
  };
  duration?: number;
}

interface CoverrVideosResponse {
  page?: number;
  pages?: number;
  page_size?: number;
  total?: number;
  hits?: CoverrVideo[];
}

/**
 * Coverr (free stock video) provider.
 *
 * IMPORTANT: Coverr's `urls.mp4` (and other `urls.*`) values are signed,
 * time-limited JWT URLs. Hotlinking them directly into a scheduled post
 * will break once the signature expires between scheduling and publish
 * time. A follow-up should download/import a user's Coverr selection into
 * our own storage (e.g. S3/Cloudinary) at selection time rather than
 * persisting the raw Coverr URL long-term.
 */
@Injectable()
export class CoverrService {
  private readonly logger = new Logger(CoverrService.name);
  private readonly apiBaseUrl = 'https://api.coverr.co';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.COVERR_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn(
        'COVERR_API_KEY not set - Coverr integration will not work',
      );
    }
  }

  /**
   * Search for videos on Coverr
   */
  async searchVideos(
    q: string,
    page: number,
    perPage: number,
  ): Promise<{ items: CoverrVideo[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Coverr API key not configured');
    }

    return this.fetchVideos(q, page, perPage);
  }

  /**
   * Get popular videos on Coverr (no search query)
   */
  async popularVideos(
    page: number,
    perPage: number,
  ): Promise<{ items: CoverrVideo[]; hasMore: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Coverr API key not configured');
    }

    return this.fetchVideos(undefined, page, perPage);
  }

  private async fetchVideos(
    q: string | undefined,
    page: number,
    perPage: number,
  ): Promise<{ items: CoverrVideo[]; hasMore: boolean }> {
    const url = new URL(`${this.apiBaseUrl}/videos`);
    if (q) url.searchParams.set('query', q);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('page_size', perPage.toString());
    url.searchParams.set('urls', 'true');

    this.logger.log(
      q
        ? `Searching Coverr videos: "${q}" (page ${page})`
        : `Fetching popular Coverr videos (page ${page})`,
    );

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Coverr API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch Coverr videos');
    }

    const data: CoverrVideosResponse = await response.json();
    const hits = data.hits || [];

    return {
      items: hits,
      hasMore: this.computeHasMore(data, page, perPage, hits.length),
    };
  }

  private computeHasMore(
    data: CoverrVideosResponse,
    page: number,
    perPage: number,
    hitsLength: number,
  ): boolean {
    if (typeof data.pages === 'number') {
      return page < data.pages;
    }
    return hitsLength === perPage;
  }
}
