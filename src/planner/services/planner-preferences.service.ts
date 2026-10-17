import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { plannerPreferences } from '../../drizzle/schema/planner-preferences.schema';
import type { UpdatePlannerPrefsDto } from '../dto/planner-prefs.dto';
import {
  mergePrefs,
  resolvePrefs,
  type PlannerPrefs,
} from '../lib/planner-prefs';

/**
 * Per-user, per-workspace Planner view settings. The caller's id always comes
 * from the JWT (the controller), never from a body, so a user can only ever
 * touch their own row.
 */
@Injectable()
export class PlannerPreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async get(userId: string, workspaceId: string): Promise<PlannerPrefs> {
    const [row] = await this.db
      .select({ prefs: plannerPreferences.prefs })
      .from(plannerPreferences)
      .where(
        and(
          eq(plannerPreferences.userId, userId),
          eq(plannerPreferences.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return resolvePrefs(row?.prefs);
  }

  /**
   * Merges `patch` into the stored document and returns the full prefs.
   *
   * Concurrency: the row is first ensured with `INSERT ... ON CONFLICT DO
   * NOTHING` (so two simultaneous first PUTs cannot 500 on the primary key),
   * then read with `SELECT ... FOR UPDATE` and rewritten in one transaction.
   * The row lock serialises every writer, so no PUT can lose another's keys.
   */
  async update(
    userId: string,
    workspaceId: string,
    patch: UpdatePlannerPrefsDto,
  ): Promise<PlannerPrefs> {
    // A patch that carries no known, valid value (empty, null-only, an empty
    // `show`) changes nothing: no transaction, no row created. The one
    // exception is `visibleCalendarIds: null`, which removes a stored key.
    const hasEffect =
      Object.keys(mergePrefs(undefined, patch)).length > 0 ||
      patch.visibleCalendarIds === null;
    if (!hasEffect) return await this.get(userId, workspaceId);
    const merged = await this.db.transaction(async (tx) => {
      await tx
        .insert(plannerPreferences)
        .values({ userId, workspaceId })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ prefs: plannerPreferences.prefs })
        .from(plannerPreferences)
        .where(
          and(
            eq(plannerPreferences.userId, userId),
            eq(plannerPreferences.workspaceId, workspaceId),
          ),
        )
        .for('update');
      const next = mergePrefs(row?.prefs, patch);
      await tx
        .update(plannerPreferences)
        .set({ prefs: next, updatedAt: new Date() })
        .where(
          and(
            eq(plannerPreferences.userId, userId),
            eq(plannerPreferences.workspaceId, workspaceId),
          ),
        );
      return next;
    });
    return resolvePrefs(merged);
  }
}
