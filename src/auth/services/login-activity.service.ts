import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import { GeoipService } from './geoip.service';

/**
 * Records where and when each session signed in.
 *
 * The timestamp and IP are written straight away so "last seen" is correct the
 * moment a request finishes. The country is a second, slower step: it needs an
 * external lookup, so it runs detached — the sign-in has already returned by the
 * time it lands. A failed or slow geo lookup therefore never touches the login
 * path, and the worst case is a row with an IP but no country yet.
 */
@Injectable()
export class LoginActivityService {
  private readonly logger = new Logger(LoginActivityService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private geoip: GeoipService,
  ) {}

  /**
   * Call on every successful authentication (login, refresh, OAuth). Awaits only
   * the cheap local write; the geo resolution is fired and forgotten so the
   * caller is never blocked on the network.
   */
  async record(userId: string, ip: string | undefined | null): Promise<void> {
    const now = new Date();
    const cleanIp = ip?.split(',')[0].trim() || null;

    try {
      await this.db
        .update(users)
        .set({ lastLoginAt: now, lastLoginIp: cleanIp, updatedAt: now })
        .where(eq(users.id, userId));
    } catch (error) {
      // Recording activity must not break auth — log and carry on.
      this.logger.warn(
        `Failed to record login activity for ${userId}: ${(error as Error).message}`,
      );
      return;
    }

    // Resolve the country out of band. No await on the caller's side.
    void this.resolveCountry(userId, cleanIp);
  }

  private async resolveCountry(
    userId: string,
    ip: string | null,
  ): Promise<void> {
    const geo = await this.geoip.lookup(ip);
    if (!geo) return;

    try {
      await this.db
        .update(users)
        .set({ country: geo.country, countryCode: geo.countryCode })
        .where(eq(users.id, userId));
    } catch (error) {
      this.logger.debug(
        `Failed to store country for ${userId}: ${(error as Error).message}`,
      );
    }
  }
}
