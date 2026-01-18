import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string; // Pexels page URL
  photographer: string;
  photographerUrl: string;
  photographerId: number;
  avgColor: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
  alt: string;
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string; // Pexels page URL
  image: string; // Thumbnail
  duration: number; // in seconds
  user: {
    id: number;
    name: string;
    url: string;
  };
  videoFiles: {
    id: number;
    quality: string; // 'hd', 'sd', 'uhd'
    fileType: string; // 'video/mp4'
    width: number;
    height: number;
    fps: number;
    link: string;
  }[];
  videoPictures: {
    id: number;
    picture: string;
    nr: number;
  }[];
}

export interface PexelsSearchOptions {
  query: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  size?: 'large' | 'medium' | 'small';
  color?: string;
  locale?: string;
  page?: number;
  perPage?: number;
}

export interface PexelsSearchResult<T> {
  items: T[];
  totalResults: number;
  page: number;
  perPage: number;
  nextPage: string | null;
  prevPage: string | null;
}

@Injectable()
export class PexelsService {
  private readonly logger = new Logger(PexelsService.name);
  private readonly apiBaseUrl = 'https://api.pexels.com';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.PEXELS_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn('PEXELS_API_KEY not set - Pexels integration will not work');
    }
  }

  /**
   * Search for photos on Pexels
   */
  async searchPhotos(options: PexelsSearchOptions): Promise<PexelsSearchResult<PexelsPhoto>> {
    const { query, orientation, size, color, locale, page = 1, perPage = 15 } = options;

    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/v1/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', Math.min(perPage, 80).toString()); // Max 80

    if (orientation) url.searchParams.set('orientation', orientation);
    if (size) url.searchParams.set('size', size);
    if (color) url.searchParams.set('color', color);
    if (locale) url.searchParams.set('locale', locale);

    this.logger.log(`Searching Pexels photos: "${query}" (page ${page})`);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Pexels API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to search Pexels photos');
    }

    const data = await response.json();

    return {
      items: (data.photos || []).map(this.mapPhoto),
      totalResults: data.total_results || 0,
      page: data.page || page,
      perPage: data.per_page || perPage,
      nextPage: data.next_page || null,
      prevPage: data.prev_page || null,
    };
  }

  /**
   * Get curated photos (editor's picks)
   */
  async getCuratedPhotos(page = 1, perPage = 15): Promise<PexelsSearchResult<PexelsPhoto>> {
    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/v1/curated`);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', Math.min(perPage, 80).toString());

    this.logger.log(`Fetching curated photos (page ${page})`);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Pexels API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch curated photos');
    }

    const data = await response.json();

    return {
      items: (data.photos || []).map(this.mapPhoto),
      totalResults: data.total_results || 0,
      page: data.page || page,
      perPage: data.per_page || perPage,
      nextPage: data.next_page || null,
      prevPage: data.prev_page || null,
    };
  }

  /**
   * Get a specific photo by ID
   */
  async getPhoto(id: number): Promise<PexelsPhoto> {
    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const response = await fetch(`${this.apiBaseUrl}/v1/photos/${id}`, {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new BadRequestException('Photo not found');
      }
      throw new BadRequestException('Failed to fetch photo');
    }

    const data = await response.json();
    return this.mapPhoto(data);
  }

  /**
   * Search for videos on Pexels
   */
  async searchVideos(options: PexelsSearchOptions): Promise<PexelsSearchResult<PexelsVideo>> {
    const { query, orientation, size, locale, page = 1, perPage = 15 } = options;

    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/videos/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', Math.min(perPage, 80).toString());

    if (orientation) url.searchParams.set('orientation', orientation);
    if (size) url.searchParams.set('size', size);
    if (locale) url.searchParams.set('locale', locale);

    this.logger.log(`Searching Pexels videos: "${query}" (page ${page})`);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Pexels API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to search Pexels videos');
    }

    const data = await response.json();

    return {
      items: (data.videos || []).map(this.mapVideo),
      totalResults: data.total_results || 0,
      page: data.page || page,
      perPage: data.per_page || perPage,
      nextPage: data.next_page || null,
      prevPage: data.prev_page || null,
    };
  }

  /**
   * Get popular videos
   */
  async getPopularVideos(
    page = 1,
    perPage = 15,
    minWidth?: number,
    minHeight?: number,
    minDuration?: number,
    maxDuration?: number,
  ): Promise<PexelsSearchResult<PexelsVideo>> {
    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const url = new URL(`${this.apiBaseUrl}/videos/popular`);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', Math.min(perPage, 80).toString());

    if (minWidth) url.searchParams.set('min_width', minWidth.toString());
    if (minHeight) url.searchParams.set('min_height', minHeight.toString());
    if (minDuration) url.searchParams.set('min_duration', minDuration.toString());
    if (maxDuration) url.searchParams.set('max_duration', maxDuration.toString());

    this.logger.log(`Fetching popular videos (page ${page})`);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Pexels API error: ${response.status} - ${errorText}`);
      throw new BadRequestException('Failed to fetch popular videos');
    }

    const data = await response.json();

    return {
      items: (data.videos || []).map(this.mapVideo),
      totalResults: data.total_results || 0,
      page: data.page || page,
      perPage: data.per_page || perPage,
      nextPage: data.next_page || null,
      prevPage: data.prev_page || null,
    };
  }

  /**
   * Get a specific video by ID
   */
  async getVideo(id: number): Promise<PexelsVideo> {
    if (!this.apiKey) {
      throw new BadRequestException('Pexels API key not configured');
    }

    const response = await fetch(`${this.apiBaseUrl}/videos/videos/${id}`, {
      headers: {
        Authorization: this.apiKey,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new BadRequestException('Video not found');
      }
      throw new BadRequestException('Failed to fetch video');
    }

    const data = await response.json();
    return this.mapVideo(data);
  }

  /**
   * Map Pexels API photo response to our interface
   */
  private mapPhoto = (photo: any): PexelsPhoto => ({
    id: photo.id,
    width: photo.width,
    height: photo.height,
    url: photo.url,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    photographerId: photo.photographer_id,
    avgColor: photo.avg_color,
    src: {
      original: photo.src.original,
      large2x: photo.src.large2x,
      large: photo.src.large,
      medium: photo.src.medium,
      small: photo.src.small,
      portrait: photo.src.portrait,
      landscape: photo.src.landscape,
      tiny: photo.src.tiny,
    },
    alt: photo.alt || '',
  });

  /**
   * Map Pexels API video response to our interface
   */
  private mapVideo = (video: any): PexelsVideo => ({
    id: video.id,
    width: video.width,
    height: video.height,
    url: video.url,
    image: video.image,
    duration: video.duration,
    user: {
      id: video.user.id,
      name: video.user.name,
      url: video.user.url,
    },
    videoFiles: (video.video_files || []).map((file: any) => ({
      id: file.id,
      quality: file.quality,
      fileType: file.file_type,
      width: file.width,
      height: file.height,
      fps: file.fps,
      link: file.link,
    })),
    videoPictures: (video.video_pictures || []).map((pic: any) => ({
      id: pic.id,
      picture: pic.picture,
      nr: pic.nr,
    })),
  });
}
