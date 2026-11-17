import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { UpdatePreferencesDto } from './dto/update-preferences.dto';
import {
  mergePreferences,
  pickPreferencePatch,
  type UserPreferences,
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
    const result = await this.db.execute(
      sql`SELECT preferences FROM users WHERE id = ${userId}`,
    );
    const row = (result.rows as unknown as PreferencesRow[])[0];
    if (!row) throw new NotFoundException('User not found');
    return mergePreferences(row.preferences);
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
    const picked = pickPreferencePatch(patch);
    if (Object.keys(picked).length === 0) return this.get(userId);
    const result = await this.db.execute(sql`
      UPDATE users
      SET preferences = preferences || ${JSON.stringify(picked)}::jsonb
      WHERE id = ${userId}
      RETURNING preferences
    `);
    const row = (result.rows as unknown as PreferencesRow[])[0];
    if (!row) throw new NotFoundException('User not found');
    return mergePreferences(row.preferences);
  }
}
