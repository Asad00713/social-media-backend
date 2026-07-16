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

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private readonly apiBaseUrl = 'https://www.googleapis.com/drive/v3';

  /**
   * Get a specific file's metadata
   */
  async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    const params = new URLSearchParams({
      fields:
        'id,name,mimeType,thumbnailLink,webContentLink,webViewLink,size,createdTime,modifiedTime',
    });

    const response = await fetch(
      `${this.apiBaseUrl}/files/${fileId}?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

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
