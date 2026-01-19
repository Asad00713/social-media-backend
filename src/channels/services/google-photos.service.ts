import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface PhotosMediaItem {
  id: string;
  productUrl: string; // URL to view in Google Photos
  baseUrl: string; // Base URL for downloading (append =w{width}-h{height} for sizing)
  mimeType: string;
  filename: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: {
      cameraMake?: string;
      cameraModel?: string;
      focalLength?: number;
      apertureFNumber?: number;
      isoEquivalent?: number;
    };
    video?: {
      fps?: number;
      status?: string;
    };
  };
}

export interface PhotosAlbum {
  id: string;
  title: string;
  productUrl: string;
  mediaItemsCount?: string;
  coverPhotoBaseUrl?: string;
  coverPhotoMediaItemId?: string;
}

export interface PhotosListResponse {
  mediaItems: PhotosMediaItem[];
  nextPageToken?: string;
}

export interface PhotosAlbumsResponse {
  albums: PhotosAlbum[];
  nextPageToken?: string;
}

@Injectable()
export class GooglePhotosService {
  private readonly logger = new Logger(GooglePhotosService.name);
  private readonly apiBaseUrl = 'https://photoslibrary.googleapis.com/v1';

  /**
   * List media items from Google Photos
   * Can filter by date range and media type
   */
  async listMediaItems(
    accessToken: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
      filters?: {
        mediaTypeFilter?: 'ALL_MEDIA' | 'PHOTO' | 'VIDEO';
        dateFilter?: {
          startDate?: { year: number; month: number; day: number };
          endDate?: { year: number; month: number; day: number };
        };
      };
    } = {},
  ): Promise<PhotosListResponse> {
    const { pageSize = 25, pageToken, albumId, filters } = options;

    // If albumId is provided, use the search endpoint
    if (albumId || filters) {
      return this.searchMediaItems(accessToken, {
        pageSize,
        pageToken,
        albumId,
        filters,
      });
    }

    // Simple list without filters
    const params = new URLSearchParams({
      pageSize: pageSize.toString(),
    });

    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(`${this.apiBaseUrl}/mediaItems?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Photos media items: ${error}`);
      throw new BadRequestException('Failed to list Google Photos media items');
    }

    const data = await response.json();

    return {
      mediaItems: data.mediaItems || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Search media items with filters
   */
  async searchMediaItems(
    accessToken: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
      filters?: {
        mediaTypeFilter?: 'ALL_MEDIA' | 'PHOTO' | 'VIDEO';
        dateFilter?: {
          startDate?: { year: number; month: number; day: number };
          endDate?: { year: number; month: number; day: number };
        };
      };
    } = {},
  ): Promise<PhotosListResponse> {
    const { pageSize = 25, pageToken, albumId, filters } = options;

    const body: Record<string, any> = {
      pageSize,
    };

    if (pageToken) {
      body.pageToken = pageToken;
    }

    if (albumId) {
      body.albumId = albumId;
    }

    if (filters) {
      body.filters = {};

      if (filters.mediaTypeFilter) {
        body.filters.mediaTypeFilter = {
          mediaTypes: [filters.mediaTypeFilter],
        };
      }

      if (filters.dateFilter) {
        body.filters.dateFilter = {
          ranges: [
            {
              startDate: filters.dateFilter.startDate,
              endDate: filters.dateFilter.endDate,
            },
          ],
        };
      }
    }

    const response = await fetch(`${this.apiBaseUrl}/mediaItems:search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to search Photos media items: ${error}`);
      throw new BadRequestException('Failed to search Google Photos media items');
    }

    const data = await response.json();

    return {
      mediaItems: data.mediaItems || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * List only photos
   */
  async listPhotos(
    accessToken: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
    } = {},
  ): Promise<PhotosListResponse> {
    return this.searchMediaItems(accessToken, {
      ...options,
      filters: {
        mediaTypeFilter: 'PHOTO',
      },
    });
  }

  /**
   * List only videos
   */
  async listVideos(
    accessToken: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
    } = {},
  ): Promise<PhotosListResponse> {
    return this.searchMediaItems(accessToken, {
      ...options,
      filters: {
        mediaTypeFilter: 'VIDEO',
      },
    });
  }

  /**
   * List all albums
   */
  async listAlbums(
    accessToken: string,
    options: {
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<PhotosAlbumsResponse> {
    const { pageSize = 50, pageToken } = options;

    const params = new URLSearchParams({
      pageSize: pageSize.toString(),
    });

    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(`${this.apiBaseUrl}/albums?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Photos albums: ${error}`);
      throw new BadRequestException('Failed to list Google Photos albums');
    }

    const data = await response.json();

    return {
      albums: data.albums || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Get a specific media item by ID
   */
  async getMediaItem(accessToken: string, mediaItemId: string): Promise<PhotosMediaItem> {
    const response = await fetch(`${this.apiBaseUrl}/mediaItems/${mediaItemId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Photos media item: ${error}`);
      throw new BadRequestException('Failed to get Google Photos media item');
    }

    return response.json();
  }

  /**
   * Get multiple media items by IDs (batch)
   */
  async batchGetMediaItems(
    accessToken: string,
    mediaItemIds: string[],
  ): Promise<PhotosMediaItem[]> {
    const params = new URLSearchParams();
    mediaItemIds.forEach((id) => params.append('mediaItemIds', id));

    const response = await fetch(`${this.apiBaseUrl}/mediaItems:batchGet?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to batch get Photos media items: ${error}`);
      throw new BadRequestException('Failed to batch get Google Photos media items');
    }

    const data = await response.json();
    return data.mediaItemResults
      ?.filter((result: any) => result.mediaItem)
      .map((result: any) => result.mediaItem) || [];
  }

  /**
   * Get download URL for a media item
   * For photos: baseUrl + '=d' for original quality download
   * For videos: baseUrl + '=dv' for video download
   */
  getDownloadUrl(mediaItem: PhotosMediaItem, options?: { width?: number; height?: number }): string {
    const { baseUrl, mediaMetadata } = mediaItem;

    // Check if it's a video
    if (mediaMetadata?.video) {
      return `${baseUrl}=dv`; // Download video
    }

    // For photos, we can specify dimensions or get original
    if (options?.width && options?.height) {
      return `${baseUrl}=w${options.width}-h${options.height}`;
    }

    return `${baseUrl}=d`; // Original quality download
  }

  /**
   * Download media item content as buffer
   */
  async downloadMediaItem(
    accessToken: string,
    mediaItem: PhotosMediaItem,
    options?: { width?: number; height?: number },
  ): Promise<Buffer> {
    const downloadUrl = this.getDownloadUrl(mediaItem, options);

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download Photos media item: ${error}`);
      throw new BadRequestException('Failed to download Google Photos media item');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Verify if the access token has Photos scopes
   */
  async verifyAccess(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/albums?pageSize=1`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
