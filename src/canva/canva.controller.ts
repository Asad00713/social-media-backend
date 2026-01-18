import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CanvaService } from './canva.service';
import {
  InitiateCanvaOAuthDto,
  RefreshCanvaTokenDto,
  CreateDesignDto,
  ListDesignsDto,
  ExportDesignDto,
  GetExportStatusDto,
  UploadAssetDto,
  CanvaDesignType,
} from './dto/canva.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { randomBytes } from 'crypto';

// Simple in-memory store for OAuth states (use Redis in production)
const oauthStates = new Map<string, { codeVerifier: string; redirectUrl: string; expiresAt: Date }>();

@Controller('canva')
export class CanvaController {
  constructor(private readonly canvaService: CanvaService) {}

  // ==========================================================================
  // OAuth Endpoints
  // ==========================================================================

  /**
   * Initiate Canva OAuth flow
   * Returns authorization URL for the frontend to redirect to
   */
  @Post('oauth/initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async initiateOAuth(
    @CurrentUser() user: { userId: string },
    @Body() dto: InitiateCanvaOAuthDto,
  ) {
    const state = randomBytes(16).toString('hex');
    const redirectUri = `${process.env.APP_URL}/canva/oauth/callback`;

    const scopes = [
      'design:content:read',
      'design:content:write',
      'design:meta:read',
      'asset:read',
      'asset:write',
      'profile:read',
    ];

    const result = this.canvaService.generateAuthUrl(redirectUri, state, scopes);

    // Store state with code verifier for callback
    oauthStates.set(state, {
      codeVerifier: result.codeVerifier,
      redirectUrl: dto.redirectUrl || process.env.FRONTEND_URL || 'http://localhost:3001',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    return {
      authorizationUrl: result.url,
      state,
    };
  }

  /**
   * OAuth callback - exchanges code for tokens
   */
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    const stateData = oauthStates.get(state);
    const frontendUrl = stateData?.redirectUrl || process.env.FRONTEND_URL || 'http://localhost:3001';

    // Clean up state
    oauthStates.delete(state);

    if (error) {
      const errorUrl = `${frontendUrl}/canva/connect/error?error=${encodeURIComponent(error)}&description=${encodeURIComponent(errorDescription || '')}`;
      return res.redirect(errorUrl);
    }

    if (!stateData || stateData.expiresAt < new Date()) {
      const errorUrl = `${frontendUrl}/canva/connect/error?error=invalid_state&description=OAuth state expired or invalid`;
      return res.redirect(errorUrl);
    }

    try {
      const redirectUri = `${process.env.APP_URL}/canva/oauth/callback`;
      const tokens = await this.canvaService.exchangeCodeForTokens(
        code,
        redirectUri,
        stateData.codeVerifier,
      );

      // Get user info
      const user = await this.canvaService.getCurrentUser(tokens.accessToken);

      // Redirect to frontend with tokens
      const successUrl = `${frontendUrl}/canva/connect/success?` +
        `accessToken=${encodeURIComponent(tokens.accessToken)}` +
        `&refreshToken=${encodeURIComponent(tokens.refreshToken)}` +
        `&expiresIn=${tokens.expiresIn}` +
        `&userId=${encodeURIComponent(user.userId)}` +
        `&displayName=${encodeURIComponent(user.displayName)}`;

      return res.redirect(successUrl);
    } catch (err) {
      const errorUrl = `${frontendUrl}/canva/connect/error?error=token_exchange_failed&description=${encodeURIComponent(err.message)}`;
      return res.redirect(errorUrl);
    }
  }

  /**
   * Refresh Canva access token
   */
  @Post('oauth/refresh')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() dto: RefreshCanvaTokenDto) {
    return this.canvaService.refreshAccessToken(dto.refreshToken);
  }

  /**
   * Get current Canva user info
   */
  @Post('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getCurrentUser(@Body('accessToken') accessToken: string) {
    return this.canvaService.getCurrentUser(accessToken);
  }

  // ==========================================================================
  // Design Endpoints
  // ==========================================================================

  /**
   * Create a new design
   * Returns design with edit URL for embedding in iframe
   */
  @Post('designs')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createDesign(
    @Body('accessToken') accessToken: string,
    @Body() dto: CreateDesignDto,
  ) {
    return this.canvaService.createDesign(accessToken, {
      designType: dto.designType,
      title: dto.title,
      assetId: dto.assetId,
    });
  }

  /**
   * List user's designs
   */
  @Post('designs/list')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDesigns(
    @Body('accessToken') accessToken: string,
    @Body() dto: ListDesignsDto,
  ) {
    return this.canvaService.listDesigns(accessToken, dto.limit, dto.continuation);
  }

  /**
   * Get a specific design
   */
  @Post('designs/:designId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDesign(
    @Param('designId') designId: string,
    @Body('accessToken') accessToken: string,
  ) {
    return this.canvaService.getDesign(accessToken, designId);
  }

  /**
   * Export a design (start export job)
   */
  @Post('designs/:designId/export')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async exportDesign(
    @Param('designId') designId: string,
    @Body('accessToken') accessToken: string,
    @Body() dto: ExportDesignDto,
  ) {
    return this.canvaService.exportDesign(accessToken, designId, {
      format: dto.format,
      quality: dto.quality,
      pages: dto.pages,
    });
  }

  /**
   * Get export job status
   */
  @Post('designs/:designId/export/:exportId/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getExportStatus(
    @Param('designId') designId: string,
    @Param('exportId') exportId: string,
    @Body('accessToken') accessToken: string,
  ) {
    return this.canvaService.getExportStatus(accessToken, designId, exportId);
  }

  /**
   * Export design and wait for completion
   * Returns download URLs when ready
   */
  @Post('designs/:designId/export-and-wait')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async exportAndWait(
    @Param('designId') designId: string,
    @Body('accessToken') accessToken: string,
    @Body() dto: ExportDesignDto,
  ) {
    // Start export
    const exportJob = await this.canvaService.exportDesign(accessToken, designId, {
      format: dto.format,
      quality: dto.quality,
      pages: dto.pages,
    });

    // Wait for completion
    const urls = await this.canvaService.waitForExport(
      accessToken,
      designId,
      exportJob.id,
    );

    return {
      exportId: exportJob.id,
      status: 'completed',
      urls,
    };
  }

  // ==========================================================================
  // Asset Endpoints
  // ==========================================================================

  /**
   * Upload an asset to Canva
   * Can be used to pre-fill a design with an image
   */
  @Post('assets/upload')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadAsset(
    @Body('accessToken') accessToken: string,
    @Body() dto: UploadAssetDto,
  ) {
    return this.canvaService.uploadAsset(accessToken, dto.name, dto.mediaUrl);
  }

  // ==========================================================================
  // Utility Endpoints
  // ==========================================================================

  /**
   * Get available design types
   */
  @Get('design-types')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getDesignTypes() {
    return Object.values(CanvaDesignType);
  }
}
