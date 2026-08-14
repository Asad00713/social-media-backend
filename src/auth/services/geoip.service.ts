import { Injectable, Logger } from '@nestjs/common';

export interface GeoLocation {
  country: string;
  countryCode: string;
}

/**
 * Turns a request IP into a country, best-effort.
 *
 * Uses ip-api.com's free endpoint — no key, ~45 req/min, which is far above any
 * real login rate. It is deliberately fault-tolerant: a lookup that fails, times
 * out, or comes back for a private address returns null rather than throwing, so
 * a geo hiccup can never block a sign-in. The caller records the IP regardless
 * and treats the country as a bonus that may arrive a moment later or not at all.
 */
@Injectable()
export class GeoipService {
  private readonly logger = new Logger(GeoipService.name);

  /** Two seconds is generous for a single JSON GET; past that, skip it. */
  private readonly TIMEOUT_MS = 2000;

  async lookup(ip: string | undefined | null): Promise<GeoLocation | null> {
    const clean = this.normalize(ip);
    if (!clean || this.isPrivate(clean)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const res = await fetch(
        `http://ip-api.com/json/${clean}?fields=status,country,countryCode`,
        { signal: controller.signal },
      );
      if (!res.ok) return null;

      const data = (await res.json()) as {
        status?: string;
        country?: string;
        countryCode?: string;
      };

      if (data.status !== 'success' || !data.country || !data.countryCode) {
        return null;
      }
      return { country: data.country, countryCode: data.countryCode };
    } catch (error) {
      // A resolver outage is not the login's problem — log and move on.
      this.logger.debug(
        `GeoIP lookup failed for ${clean}: ${(error as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Express hands back `::ffff:1.2.3.4` for IPv4-over-IPv6 and a comma list when
   * behind a proxy. Take the first, strip the mapping prefix.
   */
  private normalize(ip: string | undefined | null): string | null {
    if (!ip) return null;
    const first = ip.split(',')[0].trim();
    const unmapped = first.startsWith('::ffff:') ? first.slice(7) : first;
    return unmapped || null;
  }

  /** Loopback and RFC 1918 / unique-local ranges never resolve to a country. */
  private isPrivate(ip: string): boolean {
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true; // link-local
    if (/^(fc|fd)/i.test(ip)) return true; // IPv6 unique-local
    return false;
  }
}
