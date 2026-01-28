import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  color: string;
  blurHash: string;
  description: string | null;
  altDescription: string | null;
  urls: {
    raw: string;
    full: string;
    regular: string;
    small: string;
    thumb: string;
  };
  links: {
    self: string;
    html: string;
    download: string;
    downloadLocation: string;
  };
  user: {
    id: string;
    username: string;
    name: string;
    profileUrl: string;
    profileImage: string;
  };
}

export interface UnsplashSearchResult {
  total: number;
  totalPages: number;
  results: UnsplashPhoto[];
}

@Injectable()
export class UnsplashService {
  private readonly logger = new Logger(UnsplashService.name);
  private readonly apiBaseUrl = 'https://api.unsplash.com';

  private getAccessKey(): string {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    if (!accessKey) {
      throw new BadRequestException(
        'Unsplash API not configured. Set UNSPLASH_ACCESS_KEY environment variable.',
      );
    }
    return accessKey;
  }

  /**
   * Search for photos on Unsplash
   */
  async searchPhotos(
    query: string,
    page: number = 1,
    perPage: number = 20,
    orientation?: 'landscape' | 'portrait' | 'squarish',
    color?: string,
  ): Promise<UnsplashSearchResult> {
    const accessKey = this.getAccessKey();

    const params = new URLSearchParams({
      query,
      page: page.toString(),
      per_page: Math.min(perPage, 30).toString(), // Unsplash max is 30
    });

    if (orientation) {
      params.set('orientation', orientation);
    }
    if (color) {
      params.set('color', color);
    }

    const response = await fetch(
      `${this.apiBaseUrl}/search/photos?${params.toString()}`,
      {
        headers: {
          Authorization: `Client-ID ${accessKey}`,
          'Accept-Version': 'v1',
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Unsplash search failed: ${errorData}`);
      throw new BadRequestException('Failed to search Unsplash photos');
    }

    const data = await response.json();

    return {
      total: data.total,
      totalPages: data.total_pages,
      results: data.results.map((photo: any) => this.mapPhoto(photo)),
    };
  }

  /**
   * Get a random photo from Unsplash
   */
  async getRandomPhoto(
    query?: string,
    orientation?: 'landscape' | 'portrait' | 'squarish',
    count: number = 1,
  ): Promise<UnsplashPhoto[]> {
    const accessKey = this.getAccessKey();

    const params = new URLSearchParams({
      count: Math.min(count, 30).toString(),
    });

    if (query) {
      params.set('query', query);
    }
    if (orientation) {
      params.set('orientation', orientation);
    }

    const response = await fetch(
      `${this.apiBaseUrl}/photos/random?${params.toString()}`,
      {
        headers: {
          Authorization: `Client-ID ${accessKey}`,
          'Accept-Version': 'v1',
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Unsplash random photo failed: ${errorData}`);
      throw new BadRequestException('Failed to get random Unsplash photo');
    }

    const data = await response.json();
    const photos = Array.isArray(data) ? data : [data];

    return photos.map((photo: any) => this.mapPhoto(photo));
  }

  /**
   * Get a specific photo by ID
   */
  async getPhoto(photoId: string): Promise<UnsplashPhoto> {
    const accessKey = this.getAccessKey();

    const response = await fetch(`${this.apiBaseUrl}/photos/${photoId}`, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        'Accept-Version': 'v1',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Unsplash get photo failed: ${errorData}`);
      throw new BadRequestException('Failed to get Unsplash photo');
    }

    const data = await response.json();
    return this.mapPhoto(data);
  }

  /**
   * Track a photo download (required by Unsplash API guidelines)
   * Must be called when a user downloads/uses a photo
   */
  async trackDownload(downloadLocation: string): Promise<void> {
    const accessKey = this.getAccessKey();

    // The downloadLocation URL already includes the client_id param format
    // but we need to ensure it has our client_id
    const url = downloadLocation.includes('?')
      ? `${downloadLocation}&client_id=${accessKey}`
      : `${downloadLocation}?client_id=${accessKey}`;

    const response = await fetch(url, {
      headers: {
        'Accept-Version': 'v1',
      },
    });

    if (!response.ok) {
      this.logger.warn(`Unsplash download tracking failed: ${response.status}`);
      // Don't throw - tracking is not critical to user experience
    } else {
      this.logger.log('Unsplash download tracked successfully');
    }
  }

  /**
   * Get curated photos (editorial picks)
   */
  async getCuratedPhotos(
    page: number = 1,
    perPage: number = 20,
  ): Promise<UnsplashPhoto[]> {
    const accessKey = this.getAccessKey();

    const params = new URLSearchParams({
      page: page.toString(),
      per_page: Math.min(perPage, 30).toString(),
      order_by: 'popular',
    });

    const response = await fetch(
      `${this.apiBaseUrl}/photos?${params.toString()}`,
      {
        headers: {
          Authorization: `Client-ID ${accessKey}`,
          'Accept-Version': 'v1',
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Unsplash curated photos failed: ${errorData}`);
      throw new BadRequestException('Failed to get curated Unsplash photos');
    }

    const data = await response.json();
    return data.map((photo: any) => this.mapPhoto(photo));
  }

  /**
   * Map Unsplash API response to our interface
   */
  private mapPhoto(photo: any): UnsplashPhoto {
    return {
      id: photo.id,
      width: photo.width,
      height: photo.height,
      color: photo.color,
      blurHash: photo.blur_hash,
      description: photo.description,
      altDescription: photo.alt_description,
      urls: {
        raw: photo.urls.raw,
        full: photo.urls.full,
        regular: photo.urls.regular,
        small: photo.urls.small,
        thumb: photo.urls.thumb,
      },
      links: {
        self: photo.links.self,
        html: photo.links.html,
        download: photo.links.download,
        downloadLocation: photo.links.download_location,
      },
      user: {
        id: photo.user.id,
        username: photo.user.username,
        name: photo.user.name,
        profileUrl: photo.user.links.html,
        profileImage: photo.user.profile_image?.medium || '',
      },
    };
  }
}
