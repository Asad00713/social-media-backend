import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  oauthStates,
  platformCredentials,
  NewOAuthState,
  SupportedPlatform,
  PLATFORM_CONFIG,
} from '../../drizzle/schema/channels.schema';
import {
  generateSecureToken,
  generateCodeVerifier,
  generateCodeChallenge,
} from '../../common/utils/encryption.util';
import { InitiateOAuthDto, OAuthUrlResponseDto } from '../dto/channel.dto';

/**
 * OAuth configuration for each platform
 */
interface PlatformOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  usePKCE: boolean;
  additionalParams?: Record<string, string>;
}

const OAUTH_CONFIGS: Record<SupportedPlatform, PlatformOAuthConfig> = {
  facebook: {
    authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: PLATFORM_CONFIG.facebook.oauthScopes,
    usePKCE: false,
    additionalParams: {
      auth_type: 'rerequest',
    },
  },
  instagram: {
    authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: [
      ...PLATFORM_CONFIG.facebook.oauthScopes,
      ...PLATFORM_CONFIG.instagram.oauthScopes,
    ],
    usePKCE: false,
  },
  youtube: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: PLATFORM_CONFIG.youtube.oauthScopes,
    usePKCE: true,
    additionalParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  tiktok: {
    authorizationUrl: 'https://www.tiktok.com/v2/auth/authorize',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: PLATFORM_CONFIG.tiktok.oauthScopes,
    usePKCE: true,
  },
  pinterest: {
    authorizationUrl: 'https://www.pinterest.com/oauth/',
    // Use sandbox token URL when PINTEREST_USE_SANDBOX=true
    tokenUrl: process.env.PINTEREST_USE_SANDBOX === 'true'
      ? 'https://api-sandbox.pinterest.com/v5/oauth/token'
      : 'https://api.pinterest.com/v5/oauth/token',
    scopes: PLATFORM_CONFIG.pinterest.oauthScopes,
    usePKCE: false,
  },
  twitter: {
    authorizationUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: PLATFORM_CONFIG.twitter.oauthScopes,
    usePKCE: true,
  },
  linkedin: {
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: PLATFORM_CONFIG.linkedin.oauthScopes,
    usePKCE: false,
  },
  threads: {
    authorizationUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
    scopes: PLATFORM_CONFIG.threads.oauthScopes,
    usePKCE: false,
  },
  // Google Drive - uses same Google OAuth as YouTube but different scopes
  google_drive: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: PLATFORM_CONFIG.google_drive.oauthScopes,
    usePKCE: true,
    additionalParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  // Google Photos - uses same Google OAuth as YouTube but different scopes
  google_photos: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: PLATFORM_CONFIG.google_photos.oauthScopes,
    usePKCE: true,
    additionalParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  // Google Calendar - uses same Google OAuth as YouTube but different scopes
  google_calendar: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: PLATFORM_CONFIG.google_calendar.oauthScopes,
    usePKCE: true,
    additionalParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
};

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  // OAuth state expiration time (15 minutes)
  private readonly STATE_EXPIRATION_MINUTES = 15;

  /**
   * Initiate OAuth flow - generate authorization URL
   */
  async initiateOAuth(
    workspaceId: string,
    userId: string,
    dto: InitiateOAuthDto,
  ): Promise<OAuthUrlResponseDto> {
    const platform = dto.platform;
    const oauthConfig = OAUTH_CONFIGS[platform];

    if (!oauthConfig) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    // Get platform credentials
    const credentials = await this.getPlatformCredentials(platform);

    // Generate secure state token
    const stateToken = generateSecureToken(32);

    // Generate PKCE if needed
    let codeVerifier: string | null = null;
    let codeChallenge: string | null = null;

    if (oauthConfig.usePKCE) {
      codeVerifier = generateCodeVerifier();
      codeChallenge = generateCodeChallenge(codeVerifier);
    }

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.STATE_EXPIRATION_MINUTES);

    // Save state to database
    await db.insert(oauthStates).values({
      stateToken,
      workspaceId,
      userId,
      platform,
      redirectUrl: dto.redirectUrl || null,
      codeVerifier,
      additionalData: dto.additionalData || null,
      expiresAt,
    } as NewOAuthState);

    // Build authorization URL
    const redirectUri = this.getRedirectUri(platform);
    const authUrl = new URL(oauthConfig.authorizationUrl);

    // TikTok uses client_key instead of client_id
    if (platform === 'tiktok') {
      authUrl.searchParams.set('client_key', credentials.clientId);
    } else {
      authUrl.searchParams.set('client_id', credentials.clientId);
    }
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', stateToken);
    // TikTok uses comma-separated scopes instead of space-separated
    if (platform === 'tiktok') {
      authUrl.searchParams.set('scope', oauthConfig.scopes.join(','));
    } else {
      authUrl.searchParams.set('scope', oauthConfig.scopes.join(' '));
    }

    // Add PKCE challenge if needed
    if (codeChallenge) {
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }

    // Add platform-specific params
    if (oauthConfig.additionalParams) {
      for (const [key, value] of Object.entries(oauthConfig.additionalParams)) {
        authUrl.searchParams.set(key, value);
      }
    }

    const finalAuthUrl = authUrl.toString();
    this.logger.log(
      `Initiated OAuth flow for ${platform} in workspace ${workspaceId}`,
    );
    this.logger.log(`Authorization URL: ${finalAuthUrl}`);
    this.logger.log(`Redirect URI configured: ${redirectUri}`);

    return {
      authorizationUrl: finalAuthUrl,
      state: stateToken,
      expiresAt,
    };
  }

  /**
   * Validate OAuth state token and return the state data
   */
  async validateState(
    stateToken: string,
  ): Promise<{
    workspaceId: string;
    userId: string;
    platform: SupportedPlatform;
    codeVerifier: string | null;
    redirectUrl: string | null;
    additionalData: Record<string, any> | null;
  }> {
    this.logger.log(`Validating state token: ${stateToken.substring(0, 10)}...`);

    // First, check if the state token exists at all (ignoring expiration)
    const allStates = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateToken, stateToken))
      .limit(1);

    if (allStates.length === 0) {
      this.logger.error(`State token not found in database: ${stateToken.substring(0, 10)}...`);
      // Log recent states for debugging
      const recentStates = await db
        .select({
          id: oauthStates.id,
          stateToken: oauthStates.stateToken,
          platform: oauthStates.platform,
          expiresAt: oauthStates.expiresAt,
          usedAt: oauthStates.usedAt,
        })
        .from(oauthStates)
        .orderBy(oauthStates.createdAt)
        .limit(5);
      this.logger.log(`Recent states in DB: ${JSON.stringify(recentStates.map(s => ({ token: s.stateToken.substring(0, 10), platform: s.platform, expires: s.expiresAt })))}`);
      throw new UnauthorizedException('Invalid or expired OAuth state - token not found');
    }

    const foundState = allStates[0];
    this.logger.log(`Found state: platform=${foundState.platform}, expiresAt=${foundState.expiresAt}, usedAt=${foundState.usedAt}`);

    // Check if expired
    if (new Date(foundState.expiresAt) < new Date()) {
      this.logger.error(`State token expired: expiresAt=${foundState.expiresAt}, now=${new Date().toISOString()}`);
      throw new UnauthorizedException('Invalid or expired OAuth state - token expired');
    }

    if (foundState.usedAt) {
      this.logger.error(`State token already used at: ${foundState.usedAt}`);
      throw new UnauthorizedException('OAuth state already used');
    }

    // Mark state as used
    await db
      .update(oauthStates)
      .set({ usedAt: new Date() })
      .where(eq(oauthStates.id, foundState.id));

    this.logger.log(`State validated successfully, marked as used`);

    return {
      workspaceId: foundState.workspaceId,
      userId: foundState.userId,
      platform: foundState.platform as SupportedPlatform,
      codeVerifier: foundState.codeVerifier,
      redirectUrl: foundState.redirectUrl,
      additionalData: foundState.additionalData as Record<string, any> | null,
    };
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(
    platform: SupportedPlatform,
    code: string,
    codeVerifier: string | null,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number | null;
    tokenType: string;
    scope: string | null;
  }> {
    const oauthConfig = OAUTH_CONFIGS[platform];
    const credentials = await this.getPlatformCredentials(platform);
    const redirectUri = this.getRedirectUri(platform);

    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'authorization_code');
    tokenParams.set('code', code);
    tokenParams.set('redirect_uri', redirectUri);

    // Build headers - some platforms require Basic Auth
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    // Pinterest and Twitter require Basic Authentication header
    if (platform === 'pinterest' || platform === 'twitter') {
      const basicAuth = Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    } else if (platform === 'tiktok') {
      // TikTok uses client_key instead of client_id
      tokenParams.set('client_key', credentials.clientId);
      tokenParams.set('client_secret', credentials.clientSecret);
    } else {
      // Other platforms use body params for credentials
      tokenParams.set('client_id', credentials.clientId);
      tokenParams.set('client_secret', credentials.clientSecret);
    }

    if (codeVerifier && oauthConfig.usePKCE) {
      tokenParams.set('code_verifier', codeVerifier);
    }

    const response = await fetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers,
      body: tokenParams.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Token exchange failed for ${platform}: ${errorData}`);
      throw new BadRequestException(
        `Failed to exchange authorization code: ${response.status}`,
      );
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresIn: data.expires_in || null,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || null,
    };
  }

  /**
   * Refresh an access token
   */
  async refreshAccessToken(
    platform: SupportedPlatform,
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number | null;
  }> {
    const oauthConfig = OAUTH_CONFIGS[platform];
    const credentials = await this.getPlatformCredentials(platform);

    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'refresh_token');
    tokenParams.set('refresh_token', refreshToken);

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    // Twitter requires Basic Auth for refresh token
    if (platform === 'twitter') {
      const basicAuth = Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    } else if (platform === 'tiktok') {
      // TikTok uses client_key instead of client_id
      tokenParams.set('client_key', credentials.clientId);
      tokenParams.set('client_secret', credentials.clientSecret);
    } else {
      tokenParams.set('client_id', credentials.clientId);
      tokenParams.set('client_secret', credentials.clientSecret);
    }

    const response = await fetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers,
      body: tokenParams.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Token refresh failed for ${platform}: ${errorData}`);
      throw new BadRequestException('Failed to refresh access token');
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresIn: data.expires_in || null,
    };
  }

  /**
   * Get platform credentials from database or environment
   */
  private async getPlatformCredentials(
    platform: SupportedPlatform,
  ): Promise<{ clientId: string; clientSecret: string }> {
    // First try database
    const dbCredentials = await db
      .select()
      .from(platformCredentials)
      .where(
        and(
          eq(platformCredentials.platform, platform),
          eq(platformCredentials.isActive, true),
        ),
      )
      .limit(1);

    if (dbCredentials.length > 0) {
      return {
        clientId: dbCredentials[0].clientId,
        clientSecret: dbCredentials[0].clientSecret,
      };
    }

    // Fall back to environment variables
    // Instagram uses Facebook's Meta app credentials (same OAuth provider)
    // Google Drive and Google Photos use YouTube/Google credentials (same OAuth provider)
    let envPrefix: string;
    let hint: string;

    if (platform === 'instagram') {
      envPrefix = 'FACEBOOK';
      hint = 'Instagram uses Facebook credentials. Set FACEBOOK_CLIENT_ID and FACEBOOK_CLIENT_SECRET.';
    } else if (platform === 'google_drive' || platform === 'google_photos' || platform === 'google_calendar') {
      envPrefix = 'YOUTUBE'; // Google Drive/Photos/Calendar share the same Google OAuth app as YouTube
      hint = 'Google services use YouTube credentials. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.';
    } else {
      envPrefix = platform.toUpperCase();
      hint = `Set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET environment variables.`;
    }

    const clientId = process.env[`${envPrefix}_CLIENT_ID`];
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];

    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        `OAuth credentials not configured for ${platform}. ${hint}`,
      );
    }

    return { clientId, clientSecret };
  }

  /**
   * Get OAuth redirect URI for a platform
   */
  private getRedirectUri(platform: SupportedPlatform): string {
    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    return `${baseUrl}/channels/oauth/${platform}/callback`;
  }

  /**
   * Clean up expired OAuth states
   */
  async cleanupExpiredStates(): Promise<number> {
    const result = await db
      .delete(oauthStates)
      .where(sql`${oauthStates.expiresAt} < NOW()`)
      .returning();

    if (result.length > 0) {
      this.logger.log(`Cleaned up ${result.length} expired OAuth states`);
    }

    return result.length;
  }
}
