import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface OneDriveItem {
  id: string;
  name: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: {
    mimeType: string;
    hashes?: {
      sha1Hash?: string;
      sha256Hash?: string;
    };
  };
  folder?: {
    childCount: number;
  };
  image?: {
    width: number;
    height: number;
  };
  video?: {
    width: number;
    height: number;
    duration: number;
  };
  thumbnails?: Array<{
    id: string;
    small?: { url: string; width: number; height: number };
    medium?: { url: string; width: number; height: number };
    large?: { url: string; width: number; height: number };
  }>;
  '@microsoft.graph.downloadUrl'?: string;
}

export interface OneDriveListResponse {
  items: OneDriveItem[];
  nextLink?: string;
}

@Injectable()
export class OneDriveService {
  private readonly logger = new Logger(OneDriveService.name);
  private readonly apiBaseUrl = 'https://graph.microsoft.com/v1.0';

  /**
   * List items in OneDrive root or specific folder
   */
  async listItems(
    accessToken: string,
    options: {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { folderId, pageSize = 20, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else if (folderId) {
      url = `${this.apiBaseUrl}/me/drive/items/${folderId}/children?$top=${pageSize}&$expand=thumbnails`;
    } else {
      url = `${this.apiBaseUrl}/me/drive/root/children?$top=${pageSize}&$expand=thumbnails`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list OneDrive items: ${error}`);
      throw new BadRequestException('Failed to list OneDrive items');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * List only images from OneDrive
   */
  async listImages(
    accessToken: string,
    options: {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { folderId, pageSize = 20, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else {
      const basePath = folderId
        ? `${this.apiBaseUrl}/me/drive/items/${folderId}/children`
        : `${this.apiBaseUrl}/me/drive/root/children`;

      // Filter for image files
      url = `${basePath}?$top=${pageSize}&$expand=thumbnails&$filter=file ne null and startswith(file/mimeType,'image/')`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list OneDrive images: ${error}`);
      throw new BadRequestException('Failed to list OneDrive images');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * List only videos from OneDrive
   */
  async listVideos(
    accessToken: string,
    options: {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { folderId, pageSize = 20, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else {
      const basePath = folderId
        ? `${this.apiBaseUrl}/me/drive/items/${folderId}/children`
        : `${this.apiBaseUrl}/me/drive/root/children`;

      // Filter for video files
      url = `${basePath}?$top=${pageSize}&$expand=thumbnails&$filter=file ne null and startswith(file/mimeType,'video/')`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list OneDrive videos: ${error}`);
      throw new BadRequestException('Failed to list OneDrive videos');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * List images and videos (media files)
   */
  async listMedia(
    accessToken: string,
    options: {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { folderId, pageSize = 20, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else {
      const basePath = folderId
        ? `${this.apiBaseUrl}/me/drive/items/${folderId}/children`
        : `${this.apiBaseUrl}/me/drive/root/children`;

      // Filter for image and video files
      url = `${basePath}?$top=${pageSize}&$expand=thumbnails&$filter=file ne null and (startswith(file/mimeType,'image/') or startswith(file/mimeType,'video/'))`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list OneDrive media: ${error}`);
      throw new BadRequestException('Failed to list OneDrive media');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * List only folders from OneDrive
   */
  async listFolders(
    accessToken: string,
    options: {
      parentId?: string;
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { parentId, pageSize = 50, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else {
      const basePath = parentId
        ? `${this.apiBaseUrl}/me/drive/items/${parentId}/children`
        : `${this.apiBaseUrl}/me/drive/root/children`;

      // Filter for folders only
      url = `${basePath}?$top=${pageSize}&$filter=folder ne null`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list OneDrive folders: ${error}`);
      throw new BadRequestException('Failed to list OneDrive folders');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * Search for files by name
   */
  async searchFiles(
    accessToken: string,
    query: string,
    options: {
      pageSize?: number;
      nextLink?: string;
    } = {},
  ): Promise<OneDriveListResponse> {
    const { pageSize = 20, nextLink } = options;

    let url: string;
    if (nextLink) {
      url = nextLink;
    } else {
      url = `${this.apiBaseUrl}/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${pageSize}&$expand=thumbnails`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to search OneDrive: ${error}`);
      throw new BadRequestException('Failed to search OneDrive');
    }

    const data = await response.json();

    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'],
    };
  }

  /**
   * Get a specific item by ID
   */
  async getItem(accessToken: string, itemId: string): Promise<OneDriveItem> {
    const response = await fetch(
      `${this.apiBaseUrl}/me/drive/items/${itemId}?$expand=thumbnails`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get OneDrive item: ${error}`);
      throw new BadRequestException('Failed to get OneDrive item');
    }

    return response.json();
  }

  /**
   * Get download URL for a file
   * OneDrive items include @microsoft.graph.downloadUrl when fetched
   */
  async getDownloadUrl(accessToken: string, itemId: string): Promise<string> {
    const item = await this.getItem(accessToken, itemId);

    if (!item['@microsoft.graph.downloadUrl']) {
      throw new BadRequestException('Item is not downloadable');
    }

    return item['@microsoft.graph.downloadUrl'];
  }

  /**
   * Download file content as buffer
   */
  async downloadFile(accessToken: string, itemId: string): Promise<Buffer> {
    const downloadUrl = await this.getDownloadUrl(accessToken, itemId);

    const response = await fetch(downloadUrl);

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download OneDrive file: ${error}`);
      throw new BadRequestException('Failed to download OneDrive file');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Verify if the access token has OneDrive scopes
   */
  async verifyAccess(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/me/drive`, {
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
   * Get user's OneDrive info
   */
  async getUserInfo(accessToken: string): Promise<{
    id: string;
    driveType: string;
    owner: {
      user?: {
        displayName: string;
        email?: string;
      };
    };
    quota?: {
      total: number;
      used: number;
      remaining: number;
    };
  }> {
    // Clean the token - remove any whitespace/newlines that may have been introduced
    const cleanToken = accessToken.replace(/\s/g, '');

    this.logger.debug(`Token length: ${cleanToken.length}, starts with: ${cleanToken.substring(0, 20)}...`);

    // Detect token type: MSA compact tokens start with "EwA" or "EwB" and don't have dots
    // JWT tokens (for work/school accounts) have dots separating header.payload.signature
    const isMsaToken = cleanToken.startsWith('Ew') && !cleanToken.includes('.');

    if (isMsaToken) {
      // Use Live Connect API for personal Microsoft accounts
      this.logger.debug('Detected MSA token, using Live Connect API');
      return this.getUserInfoFromLiveApi(cleanToken);
    }

    // Use Graph API for work/school accounts (JWT tokens)
    const response = await fetch(`${this.apiBaseUrl}/me/drive`, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Failed to get OneDrive info (${response.status}): ${errorText}`);

      // Try to parse Microsoft error for better message
      try {
        const errorJson = JSON.parse(errorText);
        const msError = errorJson.error;
        if (msError) {
          this.logger.error(`Microsoft Graph error code: ${msError.code}, message: ${msError.message}`);
          throw new BadRequestException(`OneDrive API error: ${msError.code} - ${msError.message}`);
        }
      } catch (parseError) {
        // If parsing fails, use raw error
      }

      throw new BadRequestException('Failed to get OneDrive info');
    }

    return response.json();
  }

  /**
   * Get user info using Live Connect API for personal Microsoft accounts
   * Works with wl.* scopes (wl.signin, wl.skydrive)
   */
  private async getUserInfoFromLiveApi(accessToken: string): Promise<{
    id: string;
    driveType: string;
    owner: {
      user?: {
        displayName: string;
        email?: string;
      };
    };
    quota?: {
      total: number;
      used: number;
      remaining: number;
    };
  }> {
    // Get user info from Live Connect API
    const userResponse = await fetch(`https://apis.live.net/v5.0/me?access_token=${encodeURIComponent(accessToken)}`);

    if (!userResponse.ok) {
      const error = await userResponse.text();
      this.logger.error(`Failed to get Live Connect user info: ${error}`);
      throw new BadRequestException('Failed to get OneDrive user info');
    }

    const userData = await userResponse.json();
    this.logger.debug(`Live Connect user data: ${JSON.stringify(userData)}`);

    // Get OneDrive quota
    let quota: { total: number; used: number; remaining: number } | undefined;
    try {
      const quotaResponse = await fetch(`https://apis.live.net/v5.0/me/skydrive/quota?access_token=${encodeURIComponent(accessToken)}`);
      if (quotaResponse.ok) {
        const quotaData = await quotaResponse.json();
        quota = {
          total: quotaData.quota || 0,
          used: (quotaData.quota || 0) - (quotaData.available || 0),
          remaining: quotaData.available || 0,
        };
      }
    } catch (e) {
      this.logger.warn('Could not fetch OneDrive quota');
    }

    return {
      id: userData.id,
      driveType: 'personal',
      owner: {
        user: {
          displayName: userData.name || 'OneDrive User',
          email: userData.emails?.account || userData.emails?.preferred,
        },
      },
      quota,
    };
  }
}
