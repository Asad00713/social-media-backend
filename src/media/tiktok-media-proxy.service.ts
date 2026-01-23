import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface CachedMedia {
  filePath: string;
  originalUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * TikTok Media Proxy Service
 *
 * This service caches videos locally so they can be served from your own domain.
 * TikTok requires videos to be served from a verified domain for PULL_FROM_URL.
 *
 * NOTE: For production, use a proper CDN/storage solution (Cloudflare R2, S3, etc.)
 * Railway has ephemeral storage - files are lost on redeployment.
 */
@Injectable()
export class TikTokMediaProxyService {
  private readonly logger = new Logger(TikTokMediaProxyService.name);
  private readonly cacheDir: string;
  private readonly mediaCache = new Map<string, CachedMedia>();
  private readonly CACHE_DURATION_HOURS = 2; // TikTok needs 1 hour, we keep 2

  constructor(private readonly configService: ConfigService) {
    // Use /tmp for Railway (ephemeral but works)
    this.cacheDir = process.env.MEDIA_CACHE_DIR || '/tmp/tiktok-media-cache';
    this.ensureCacheDir();
    this.startCleanupInterval();
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
