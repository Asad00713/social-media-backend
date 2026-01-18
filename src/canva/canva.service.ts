import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';

export interface CanvaTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface CanvaUser {
  userId: string;
  displayName: string;
}

export interface CanvaDesign {
  id: string;
  title: string;
  url: string;
  editUrl?: string;
  thumbnail?: {
    url: string;
    width: number;
    height: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CanvaExportJob {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  urls?: string[];
  error?: string;
}

export interface CreateDesignOptions {
  designType?: 'Instagram Post' | 'Facebook Post' | 'Twitter Post' | 'Pinterest Pin' | 'YouTube Thumbnail' | 'Presentation' | 'Document' | 'Whiteboard' | 'Video';
  title?: string;
  assetId?: string; // Pre-fill with an uploaded asset
}

export interface ExportDesignOptions {
  format: 'png' | 'jpg' | 'pdf' | 'mp4' | 'gif';
  quality?: 'low' | 'medium' | 'high';
  pages?: number[]; // Specific pages to export
}

@Injectable()
export class CanvaService {
  private readonly logger = new Logger(CanvaService.name);
  private readonly apiBaseUrl = 'https://api.canva.com/rest/v1';
  private readonly authBaseUrl = 'https://www.canva.com/api/oauth';
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor() {
    this.clientId = process.env.CANVA_CLIENT_ID || '';
    this.clientSecret = process.env.CANVA_CLIENT_SECRET || '';

    if (!this.clientId || !this.clientSecret) {
      this.logger.warn('CANVA_CLIENT_ID or CANVA_CLIENT_SECRET not set - Canva integration will not work');
    }
  }

  /**
   * Generate OAuth authorization URL
   */
  generateAuthUrl(
    redirectUri: string,
    state: string,
    scopes: string[],
  ): { url: string; codeVerifier: string } {
    if (!this.clientId) {
      throw new BadRequestException('Canva client ID not configured');
    }

    // Generate code verifier and challenge for PKCE
    const codeVerifier = randomBytes(32).toString('base64url');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: scopes.join(' '),
      code_challenge: codeVerifier, // For simplicity using plain method
      code_challenge_method: 'plain',
    });

    return {
      url: `${this.authBaseUrl}/authorize?${params.toString()}`,
      codeVerifier,
    };
  }

  /**
   * Exchange authorization code for access tokens
   */
  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<CanvaTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new BadRequestException('Canva credentials not configured');
    }

    const response = await fetch(`${this.authBaseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Canva token exchange failed: ${error}`);
      throw new BadRequestException('Failed to exchange Canva authorization code');
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken: string): Promise<CanvaTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new BadRequestException('Canva credentials not configured');
    }

    const response = await fetch(`${this.authBaseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Canva token refresh failed: ${error}`);
      throw new BadRequestException('Failed to refresh Canva access token');
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  /**
   * Get current user info
   */
  async getCurrentUser(accessToken: string): Promise<CanvaUser> {
    const response = await fetch(`${this.apiBaseUrl}/users/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Canva user: ${error}`);
      throw new BadRequestException('Failed to get Canva user info');
    }

    const data = await response.json();

    return {
      userId: data.user?.id || data.id,
      displayName: data.user?.display_name || data.display_name || 'Canva User',
    };
  }

  /**
   * Create a new design
   * Returns a design with an edit URL that can be opened in an iframe or popup
   */
  async createDesign(
    accessToken: string,
    options: CreateDesignOptions = {},
  ): Promise<CanvaDesign> {
    const { designType = 'Instagram Post', title, assetId } = options;

    const body: Record<string, any> = {
      design_type: {
        type: designType.toLowerCase().replace(/ /g, '_'),
      },
    };

    if (title) {
      body.title = title;
    }

    if (assetId) {
      body.asset_id = assetId;
    }

    this.logger.log(`Creating Canva design: ${designType}`);

    const response = await fetch(`${this.apiBaseUrl}/designs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    this.logger.log(`Canva create design response: ${responseText}`);

    if (!response.ok) {
      this.logger.error(`Failed to create Canva design: ${responseText}`);
      throw new BadRequestException('Failed to create Canva design');
    }

    const data = JSON.parse(responseText);
    const design = data.design || data;

    return {
      id: design.id,
      title: design.title || title || 'Untitled',
      url: design.url,
      editUrl: design.edit_url || design.urls?.edit_url,
      thumbnail: design.thumbnail ? {
        url: design.thumbnail.url,
        width: design.thumbnail.width,
        height: design.thumbnail.height,
      } : undefined,
      createdAt: design.created_at,
      updatedAt: design.updated_at,
    };
  }

  /**
   * Get a design by ID
   */
  async getDesign(accessToken: string, designId: string): Promise<CanvaDesign> {
    const response = await fetch(`${this.apiBaseUrl}/designs/${designId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Canva design: ${error}`);
      throw new BadRequestException('Failed to get Canva design');
    }

    const data = await response.json();
    const design = data.design || data;

    return {
      id: design.id,
      title: design.title,
      url: design.url,
      editUrl: design.edit_url || design.urls?.edit_url,
      thumbnail: design.thumbnail ? {
        url: design.thumbnail.url,
        width: design.thumbnail.width,
        height: design.thumbnail.height,
      } : undefined,
      createdAt: design.created_at,
      updatedAt: design.updated_at,
    };
  }

  /**
   * List user's designs
   */
  async listDesigns(
    accessToken: string,
    limit = 20,
    continuation?: string,
  ): Promise<{ designs: CanvaDesign[]; continuation?: string }> {
    const url = new URL(`${this.apiBaseUrl}/designs`);
    url.searchParams.set('limit', Math.min(limit, 100).toString());
    if (continuation) {
      url.searchParams.set('continuation', continuation);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Canva designs: ${error}`);
      throw new BadRequestException('Failed to list Canva designs');
    }

    const data = await response.json();

    return {
      designs: (data.items || data.designs || []).map((design: any) => ({
        id: design.id,
        title: design.title,
        url: design.url,
        editUrl: design.edit_url || design.urls?.edit_url,
        thumbnail: design.thumbnail ? {
          url: design.thumbnail.url,
          width: design.thumbnail.width,
          height: design.thumbnail.height,
        } : undefined,
        createdAt: design.created_at,
        updatedAt: design.updated_at,
      })),
      continuation: data.continuation,
    };
  }

  /**
   * Start an export job for a design
   */
  async exportDesign(
    accessToken: string,
    designId: string,
    options: ExportDesignOptions,
  ): Promise<CanvaExportJob> {
    const { format, quality = 'high', pages } = options;

    const body: Record<string, any> = {
      format: {
        type: format,
      },
    };

    if (quality && format !== 'pdf') {
      body.format.quality = quality;
    }

    if (pages && pages.length > 0) {
      body.pages = pages;
    }

    this.logger.log(`Exporting Canva design ${designId} as ${format}`);

    const response = await fetch(`${this.apiBaseUrl}/designs/${designId}/exports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    this.logger.log(`Canva export response: ${responseText}`);

    if (!response.ok) {
      this.logger.error(`Failed to export Canva design: ${responseText}`);
      throw new BadRequestException('Failed to export Canva design');
    }

    const data = JSON.parse(responseText);
    const job = data.job || data;

    return {
      id: job.id,
      status: job.status,
      urls: job.urls,
      error: job.error?.message,
    };
  }

  /**
   * Get export job status
   */
  async getExportStatus(
    accessToken: string,
    designId: string,
    exportId: string,
  ): Promise<CanvaExportJob> {
    const response = await fetch(
      `${this.apiBaseUrl}/designs/${designId}/exports/${exportId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get export status: ${error}`);
      throw new BadRequestException('Failed to get export status');
    }

    const data = await response.json();
    const job = data.job || data;

    return {
      id: job.id,
      status: job.status,
      urls: job.urls,
      error: job.error?.message,
    };
  }

  /**
   * Wait for export to complete and return download URLs
   */
  async waitForExport(
    accessToken: string,
    designId: string,
    exportId: string,
    maxWaitMs = 60000,
    pollIntervalMs = 2000,
  ): Promise<string[]> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getExportStatus(accessToken, designId, exportId);

      if (status.status === 'completed' && status.urls) {
        return status.urls;
      }

      if (status.status === 'failed') {
        throw new BadRequestException(status.error || 'Export failed');
      }

      // Still processing, wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new BadRequestException('Export timed out');
  }

  /**
   * Upload an asset to Canva
   */
  async uploadAsset(
    accessToken: string,
    name: string,
    mediaUrl: string,
  ): Promise<{ assetId: string; status: string }> {
    const body = {
      name,
      url: mediaUrl,
    };

    this.logger.log(`Uploading asset to Canva: ${name}`);

    const response = await fetch(`${this.apiBaseUrl}/assets/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();

    if (!response.ok) {
      this.logger.error(`Failed to upload asset to Canva: ${responseText}`);
      throw new BadRequestException('Failed to upload asset to Canva');
    }

    const data = JSON.parse(responseText);
    const job = data.job || data;

    return {
      assetId: job.asset?.id || job.id,
      status: job.status,
    };
  }
}
