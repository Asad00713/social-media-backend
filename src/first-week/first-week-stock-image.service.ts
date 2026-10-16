import { Injectable, Logger } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';

export interface StockImage {
  url: string;
  width: number;
  height: number;
  alt: string;
  credit: {
    provider: 'unsplash' | 'pexels';
    author: string;
    pageUrl: string;
  };
}

const isHttps = (u: unknown): u is string =>
  typeof u === 'string' && u.startsWith('https://');

/**
 * One stock photo for a draft: Unsplash first, then Pexels. Never throws; a
 * missing key or a rate limit just means the draft has no image (its row then
 * offers "Add image").
 */
@Injectable()
export class FirstWeekStockImageService {
  private readonly logger = new Logger(FirstWeekStockImageService.name);

  constructor(
    private readonly unsplash: UnsplashService,
    private readonly pexels: PexelsService,
  ) {}

  async find(query: string): Promise<StockImage | null> {
    const q = query.trim();
    if (!q) return null;
    return (await this.fromUnsplash(q)) ?? (await this.fromPexels(q));
  }

  private async fromUnsplash(q: string): Promise<StockImage | null> {
    try {
      const res = await this.unsplash.searchPhotos(q, 1, 1, 'squarish');
      const p = res.results[0];
      const url = [p?.urls?.regular, p?.urls?.small].find(isHttps);
      if (!p || !url) return null;
      // Unsplash's API terms ask for a download ping when a photo is used.
      void this.unsplash
        .trackDownload(p.links.downloadLocation)
        .catch(() => undefined);
      return {
        url,
        width: p.width,
        height: p.height,
        alt: p.altDescription ?? p.description ?? q,
        credit: {
          provider: 'unsplash',
          author: p.user?.name ?? '',
          pageUrl: p.links?.html ?? '',
        },
      };
    } catch (err) {
      this.logger.warn(
        `Unsplash lookup failed for "${q}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async fromPexels(q: string): Promise<StockImage | null> {
    try {
      const res = await this.pexels.searchPhotos({
        query: q,
        perPage: 1,
        orientation: 'square',
      });
      const p = res.items[0];
      const url = [p?.src?.large, p?.src?.medium].find(isHttps);
      if (!p || !url) return null;
      return {
        url,
        width: p.width,
        height: p.height,
        alt: p.alt || q,
        credit: {
          provider: 'pexels',
          author: p.photographer ?? '',
          pageUrl: p.url ?? '',
        },
      };
    } catch (err) {
      this.logger.warn(
        `Pexels lookup failed for "${q}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
