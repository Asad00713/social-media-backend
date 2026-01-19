import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  webContentLink?: string;
  webViewLink?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private readonly apiBaseUrl = 'https://www.googleapis.com/drive/v3';

  /**
   * List files in Google Drive
   * Can filter by folder, mime type, and search query
   */
  async listFiles(
    accessToken: string,
    options: {
      folderId?: string;
      mimeTypes?: string[];
      query?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<DriveListResponse> {
    const { folderId, mimeTypes, query, pageSize = 20, pageToken } = options;

    // Build query string
    const queryParts: string[] = [];

    // Filter by folder
    if (folderId) {
      queryParts.push(`'${folderId}' in parents`);
    }

    // Filter by mime types (images and videos)
    if (mimeTypes && mimeTypes.length > 0) {
      const mimeQuery = mimeTypes
        .map((type) => `mimeType contains '${type}'`)
        .join(' or ');
      queryParts.push(`(${mimeQuery})`);
    }

    // Search by name
    if (query) {
      queryParts.push(`name contains '${query}'`);
    }

    // Exclude trashed files
    queryParts.push('trashed = false');

    const params = new URLSearchParams({
      pageSize: pageSize.toString(),
      fields: 'nextPageToken,files(id,name,mimeType,thumbnailLink,webContentLink,webViewLink,size,createdTime,modifiedTime)',
      orderBy: 'modifiedTime desc',
    });

    if (queryParts.length > 0) {
      params.append('q', queryParts.join(' and '));
    }

    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(`${this.apiBaseUrl}/files?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Drive files: ${error}`);
      throw new BadRequestException('Failed to list Google Drive files');
    }

    const data = await response.json();

    return {
      files: data.files || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * List only images from Google Drive
   */
  async listImages(
    accessToken: string,
    options: {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<DriveListResponse> {
    return this.listFiles(accessToken, {
      ...options,
      mimeTypes: ['image/'],
    });
  }

  /**
   * List only videos from Google Drive
   */
  async listVideos(
    accessToken: string,
    options: {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<DriveListResponse> {
    return this.listFiles(accessToken, {
      ...options,
      mimeTypes: ['video/'],
    });
  }

  /**
   * List images and videos (media files)
   */
  async listMedia(
    accessToken: string,
    options: {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<DriveListResponse> {
    return this.listFiles(accessToken, {
      ...options,
      mimeTypes: ['image/', 'video/'],
    });
  }

  /**
   * List folders in Google Drive
   */
  async listFolders(
    accessToken: string,
    options: {
      parentId?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<{ folders: DriveFolder[]; nextPageToken?: string }> {
    const { parentId, pageSize = 50, pageToken } = options;

    const queryParts: string[] = [
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false',
    ];

    if (parentId) {
      queryParts.push(`'${parentId}' in parents`);
    }

    const params = new URLSearchParams({
      pageSize: pageSize.toString(),
      fields: 'nextPageToken,files(id,name)',
      orderBy: 'name',
      q: queryParts.join(' and '),
    });

    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(`${this.apiBaseUrl}/files?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Drive folders: ${error}`);
      throw new BadRequestException('Failed to list Google Drive folders');
    }

    const data = await response.json();

    return {
      folders: data.files || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Get a specific file's metadata
   */
  async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,thumbnailLink,webContentLink,webViewLink,size,createdTime,modifiedTime',
    });

    const response = await fetch(`${this.apiBaseUrl}/files/${fileId}?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Drive file: ${error}`);
      throw new BadRequestException('Failed to get Google Drive file');
    }

    return response.json();
  }

  /**
   * Get a direct download URL for a file
   * Note: webContentLink only works for files with sharing enabled
   * This method returns a URL that can be used with the access token
   */
  getDownloadUrl(fileId: string): string {
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  /**
   * Download file content as buffer
   */
  async downloadFile(accessToken: string, fileId: string): Promise<Buffer> {
    const response = await fetch(this.getDownloadUrl(fileId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download Drive file: ${error}`);
      throw new BadRequestException('Failed to download Google Drive file');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Verify if the access token has Drive scopes
   */
  async verifyAccess(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/about?fields=user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get user's Drive info
   */
  async getUserInfo(accessToken: string): Promise<{
    email: string;
    displayName: string;
    photoLink?: string;
  }> {
    const response = await fetch(`${this.apiBaseUrl}/about?fields=user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Drive user info: ${error}`);
      throw new BadRequestException('Failed to get Google Drive user info');
    }

    const data = await response.json();
    return {
      email: data.user?.emailAddress,
      displayName: data.user?.displayName,
      photoLink: data.user?.photoLink,
    };
  }
}
