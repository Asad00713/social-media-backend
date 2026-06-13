import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface CachedMedia {
  filePath: string;
  originalUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

interface MediaTokenPayload {
  url: string;
  iat?: number;
  exp?: number;
}

/**
 * TikTok Media Proxy Service
 *
 * Two responsibilities:
 *
 * 1. **Token mint / verify (preferred, used by current PULL_FROM_URL flow):**
 *    Mints a short-lived signed JWT that wraps the original Cloudinary/R2 URL.
 *    The verified-domain endpoint (`/api/tiktok-media/:token`) decodes the
 *    token and streams the upstream bytes through. TikTok only ever sees a
 *    URL on `api.schedura.ai`, satisfying the dev-console verified-domain
 *    requirement without any pre-caching.
 *
 * 2. **Legacy disk cache (kept for backwards compatibility):**
 *    Older `cacheVideo` / `getMediaStream` path that downloaded videos to
 *    `/tmp` and served them via `/media/tiktok-proxy/:mediaId`. Retained for
 *    any callers still using the old controller route — new code should use
 *    the token-based flow.
 *
 * IMPORTANT (TikTok policy compliance, Point 5): this service must NOT inject
 * any Schedura watermark, logo, or branding overlay into media bound for
 * TikTok. Audited 2026-06-13 — no overlay code present. Do not add any.
 */
@Injectable()
export class TikTokMediaProxyService {
  private readonly logger = new Logger(TikTokMediaProxyService.name);
  private readonly cacheDir: string;
  private readonly mediaCache = new Map<string, CachedMedia>();
  private readonly CACHE_DURATION_HOURS = 2; // TikTok needs 1 hour, we keep 2
  private readonly tokenTtlSeconds = 60 * 60; // 1 hour — matches TikTok's max PULL window

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    // Use /tmp for Railway (ephemeral but works)
    this.cacheDir = process.env.MEDIA_CACHE_DIR || '/tmp/tiktok-media-cache';
    this.ensureCacheDir();
    this.startCleanupInterval();
  }

  // ==========================================================================
  // Token-based proxy (preferred flow — used by tiktok.publisher.ts)
  // ==========================================================================

  /**
   * Mint a short-lived signed token wrapping the original media URL.
   * The token is appended to `/api/tiktok-media/:token` and handed to TikTok
   * so the verified-domain endpoint can stream the upstream bytes through.
   */
  mintProxyToken(originalUrl: string): string {
    const payload: MediaTokenPayload = { url: originalUrl };
    const secret =
      process.env.JWT_ACCESS_SECRET ??
      this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error(
        'JWT_ACCESS_SECRET is not configured — cannot mint TikTok proxy token',
      );
    }
    return this.jwtService.sign(payload, {
      secret,
      expiresIn: this.tokenTtlSeconds,
    });
  }

  /**
   * Verify a proxy token and return the wrapped original URL.
   * Throws if the token is invalid or expired.
   */
  verifyProxyToken(token: string): string {
    const secret =
      process.env.JWT_ACCESS_SECRET ??
      this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error(
        'JWT_ACCESS_SECRET is not configured — cannot verify TikTok proxy token',
      );
    }
    const decoded = this.jwtService.verify<MediaTokenPayload>(token, { secret });
    return decoded.url;
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      this.logger.log(`Created media cache directory: ${this.cacheDir}`);
    }
  }

  /**
   * Cache a video from an external URL (like Cloudinary)
   * Returns a local media ID that can be used to serve the video
   */
  async cacheVideo(externalUrl: string): Promise<{
    mediaId: string;
    localUrl: string;
    expiresAt: Date;
  }> {
    // Generate a unique ID for this media
    const mediaId = crypto.randomBytes(16).toString('hex');

    this.logger.log(`Caching video from: ${externalUrl}`);

    // Download the video
    const response = await fetch(externalUrl);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const filePath = path.join(this.cacheDir, `${mediaId}.mp4`);

    // Write to disk
    fs.writeFileSync(filePath, Buffer.from(buffer));

    const expiresAt = new Date(Date.now() + this.CACHE_DURATION_HOURS * 60 * 60 * 1000);

    // Store in memory cache
    this.mediaCache.set(mediaId, {
      filePath,
      originalUrl: externalUrl,
      createdAt: new Date(),
      expiresAt,
    });

    const appUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    const localUrl = `${appUrl}/media/tiktok-proxy/${mediaId}`;

    this.logger.log(`Video cached: ${mediaId}, serves at: ${localUrl}`);

    return {
      mediaId,
      localUrl,
      expiresAt,
    };
  }

  /**
   * Get the file path for a cached media
   */
  getMediaPath(mediaId: string): string {
    const cached = this.mediaCache.get(mediaId);

    // Check memory cache first
    if (cached) {
      if (new Date() > cached.expiresAt) {
        this.deleteMedia(mediaId);
        throw new NotFoundException('Media has expired');
      }
      if (fs.existsSync(cached.filePath)) {
        return cached.filePath;
      }
    }

    // Check disk directly (in case of restart)
    const filePath = path.join(this.cacheDir, `${mediaId}.mp4`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }

    throw new NotFoundException('Media not found');
  }

  /**
   * Get media stream for serving
   */
  getMediaStream(mediaId: string): fs.ReadStream {
    const filePath = this.getMediaPath(mediaId);
    return fs.createReadStream(filePath);
  }

  /**
   * Get media file stats
   */
  getMediaStats(mediaId: string): fs.Stats {
    const filePath = this.getMediaPath(mediaId);
    return fs.statSync(filePath);
  }

  /**
   * Delete a cached media file
   */
  deleteMedia(mediaId: string): void {
    const cached = this.mediaCache.get(mediaId);
    if (cached && fs.existsSync(cached.filePath)) {
      fs.unlinkSync(cached.filePath);
    }
    this.mediaCache.delete(mediaId);
    this.logger.log(`Deleted cached media: ${mediaId}`);
  }

  /**
   * Clean up expired media files
   */
  private cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [mediaId, cached] of this.mediaCache.entries()) {
      if (now > cached.expiresAt) {
        this.deleteMedia(mediaId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} expired media files`);
    }
  }

  /**
   * Start periodic cleanup
   */
  private startCleanupInterval(): void {
    // Clean up every 30 minutes
    setInterval(() => this.cleanupExpired(), 30 * 60 * 1000);
  }

  /**
   * Get cache stats
   */
  getCacheStats(): {
    cachedCount: number;
    cacheDir: string;
  } {
    return {
      cachedCount: this.mediaCache.size,
      cacheDir: this.cacheDir,
    };
  }
}
