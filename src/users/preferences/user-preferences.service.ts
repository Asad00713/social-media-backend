import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { UpdatePreferencesDto } from './dto/update-preferences.dto';
import {
  mergePreferences,
  pickPreferencePatch,
  toPreferencesResponse,
  type UserPreferences,
  type UserPreferencesResponse,
} from './user-preferences';

interface PreferencesRow {
  preferences: unknown;
}

/** The signed-in person's own preferences, stored sparsely in users.preferences. */
@Injectable()
export class UserPreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** Every field present: stored values over the defaults. */
  async get(userId: string): Promise<UserPreferences> {
    return mergePreferences(await this.readStored(userId));
  }

  /**
   * {@link get}, plus `explicitKeys`: which of those values the user chose.
   * For the preferences route; server-side readers use {@link get}.
   */
  async getWithExplicitKeys(userId: string): Promise<UserPreferencesResponse> {
    return toPreferencesResponse(await this.readStored(userId));
  }

  /**
   * Merges the patch into the stored object IN SQL (`preferences || patch`),
   * so two concurrent patches of different keys both survive; a read-modify-
   * write here would let the later one erase the earlier. Only
   * {@link UserPreferences} keys are copied, so nothing else is ever stored.
   */
  async update(
    userId: string,
    patch: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    return mergePreferences(await this.writeStored(userId, patch));
  }

  /** {@link update}, returning `explicitKeys` too (see {@link getWithExplicitKeys}). */
  async updateWithExplicitKeys(
    userId: string,
    patch: UpdatePreferencesDto,
  ): Promise<UserPreferencesResponse> {
    return toPreferencesResponse(await this.writeStored(userId, patch));
  }

  private async readStored(userId: string): Promise<unknown> {
    const result = await this.db.execute(
      sql`SELECT preferences FROM users WHERE id = ${userId}`,
    );
    const row = (result.rows as unknown as PreferencesRow[])[0];
    if (!row) throw new NotFoundException('User not found');
    return row.preferences;
  }

  /** The stored object after the patch; a patch with nothing to store reads. */
  private async writeStored(
    userId: string,
    patch: UpdatePreferencesDto,
  ): Promise<unknown> {
    const picked = pickPreferencePatch(patch);
    if (Object.keys(picked).length === 0) return this.readStored(userId);
    const result = await this.db.execute(sql`
      UPDATE users
      SET preferences = preferences || ${JSON.stringify(picked)}::jsonb
      WHERE id = ${userId}
      RETURNING preferences
    `);
    const row = (result.rows as unknown as PreferencesRow[])[0];
    if (!row) throw new NotFoundException('User not found');
    return row.preferences;
  }
}
