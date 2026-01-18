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
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
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
import { db } from '../drizzle/db';
import { oauthStates, NewOAuthState } from '../drizzle/schema/channels.schema';

@Controller('canva')
export class CanvaController {
  private readonly logger = new Logger(CanvaController.name);

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
    @CurrentUser() user: { userId: string; workspaceId?: string },
    @Body() dto: InitiateCanvaOAuthDto,
  ) {
    const state = randomBytes(32).toString('hex');
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

    // Calculate expiration (15 minutes)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Store state in database for persistence across server restarts
    // Use the user's workspace if available, otherwise use a placeholder
    const workspaceId = user.workspaceId || dto.workspaceId;
    if (!workspaceId) {
      throw new Error('Workspace ID is required for Canva OAuth');
    }

    await db.insert(oauthStates).values({
      stateToken: state,
      workspaceId,
      userId: user.userId,
      platform: 'canva',
      redirectUrl: dto.redirectUrl || process.env.FRONTEND_URL || 'http://localhost:3001',
      codeVerifier: result.codeVerifier,
      expiresAt,
    } as NewOAuthState);

    this.logger.log(`Canva OAuth initiated for user ${user.userId}, state: ${state.substring(0, 10)}...`);

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
    const defaultFrontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    this.logger.log(`Canva OAuth callback received. State: ${state?.substring(0, 10)}...`);

    // Look up state in database
    const stateRecords = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateToken, state))
      .limit(1);

    const stateData = stateRecords[0];
    // Use base frontend URL (strip any path that might have been included)
    let frontendUrl = stateData?.redirectUrl || defaultFrontendUrl;
    try {
      const urlObj = new URL(frontendUrl);
      frontendUrl = urlObj.origin; // Get just protocol + host
    } catch {
      // If invalid URL, use as-is
    }
    this.logger.log(`Using frontend URL for redirect: ${frontendUrl}`);

    // Handle errors from Canva
    if (error) {
      this.logger.error(`Canva OAuth error: ${error} - ${errorDescription}`);
      const errorUrl = `${frontendUrl}/canva/connect/error?error=${encodeURIComponent(error)}&description=${encodeURIComponent(errorDescription || '')}`;
      return res.redirect(errorUrl);
    }

    // Validate state
    if (!stateData) {
      this.logger.error(`State token not found in database: ${state?.substring(0, 10)}...`);
      const errorUrl = `${frontendUrl}/canva/connect/error?error=invalid_state&description=OAuth state not found`;
      return res.redirect(errorUrl);
    }

    if (new Date(stateData.expiresAt) < new Date()) {
      this.logger.error(`State token expired: ${state?.substring(0, 10)}...`);
      const errorUrl = `${frontendUrl}/canva/connect/error?error=invalid_state&description=OAuth state expired`;
      return res.redirect(errorUrl);
    }

    if (stateData.usedAt) {
      this.logger.error(`State token already used: ${state?.substring(0, 10)}...`);
      const errorUrl = `${frontendUrl}/canva/connect/error?error=invalid_state&description=OAuth state already used`;
      return res.redirect(errorUrl);
    }

    // Mark state as used
    await db
      .update(oauthStates)
      .set({ usedAt: new Date() })
      .where(eq(oauthStates.id, stateData.id));

    try {
      const redirectUri = `${process.env.APP_URL}/canva/oauth/callback`;
      this.logger.log(`Exchanging code for tokens with redirect URI: ${redirectUri}`);

      const tokens = await this.canvaService.exchangeCodeForTokens(
        code,
        redirectUri,
        stateData.codeVerifier!,
      );

      // Get user info
      const user = await this.canvaService.getCurrentUser(tokens.accessToken);

      this.logger.log(`Canva OAuth successful for user: ${user.displayName}`);

      // Redirect to frontend with tokens
      const successUrl = `${frontendUrl}/canva/connect/success?` +
        `accessToken=${encodeURIComponent(tokens.accessToken)}` +
        `&refreshToken=${encodeURIComponent(tokens.refreshToken)}` +
        `&expiresIn=${tokens.expiresIn}` +
        `&userId=${encodeURIComponent(user.userId)}` +
        `&displayName=${encodeURIComponent(user.displayName)}`;

      return res.redirect(successUrl);
    } catch (err) {
      this.logger.error(`Canva token exchange failed: ${err.message}`);
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
  async createDesign(@Body() dto: CreateDesignDto) {
    return this.canvaService.createDesign(dto.accessToken, {
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
  async listDesigns(@Body() dto: ListDesignsDto) {
    return this.canvaService.listDesigns(dto.accessToken, dto.limit, dto.continuation);
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
    @Body() dto: ExportDesignDto,
  ) {
    return this.canvaService.exportDesign(dto.accessToken, designId, {
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
    @Body() dto: ExportDesignDto,
  ) {
    // Start export
    const exportJob = await this.canvaService.exportDesign(dto.accessToken, designId, {
      format: dto.format,
      quality: dto.quality,
      pages: dto.pages,
    });

    // Wait for completion
    const urls = await this.canvaService.waitForExport(
      dto.accessToken,
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
  async uploadAsset(@Body() dto: UploadAssetDto) {
    return this.canvaService.uploadAsset(dto.accessToken, dto.name, dto.mediaUrl);
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
