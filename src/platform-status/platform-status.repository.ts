import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  platformIncidents,
  platformStatus,
  platformStatusChanges,
  type PlatformIncidentRow,
  type PlatformStatusChangeRow,
} from '../drizzle/schema/platform-status.schema';
import {
  MAX_LAG_SAMPLE_MS,
  PUBLISH_WINDOW_MS,
  SYNC_WINDOW_MS,
  DELAYED_LAG_MS,
  RECOVERY_FACTOR,
  type PlatformSignals,
} from './lib/classify';
import type {
  ActiveIncident,
  NextStatus,
  StatusChange,
  StoredStatus,
} from './lib/effective-status';

/** A transaction or the root db: both run the same queries. */
export type Executor = Pick<
  DbType,
  'select' | 'insert' | 'update' | 'execute' | 'delete'
>;

/** A raw result row of `db.execute` (node-postgres). */
type Rows<T> = { rows: T[] };

/** The key every writer of platform_status takes first: the two-minute
 *  measurement and an admin posting an incident must not interleave. */
const STATUS_LOCK_KEY = 'platform_status';

/** An ISO-8601 instant, as `Date#toISOString` writes into posts.targets. A
 *  hand-edited or legacy value must not make the cast throw. */
const ISO_INSTANT = '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?Z$';

function emptySignals(): PlatformSignals {
  return { publishes: [], lags: [], syncs: [] };
}

function bucket(
  map: Map<string, PlatformSignals>,
  platform: string,
): PlatformSignals {
  let signals = map.get(platform);
  if (!signals) {
    signals = emptySignals();
    map.set(platform, signals);
  }
  return signals;
}

@Injectable()
export class PlatformStatusRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** Runs `fn` in a transaction that holds the platform_status write lock. */
  async withStatusLock<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${STATUS_LOCK_KEY}))`,
      );
      return fn(tx);
    });
  }

  /**
   * Every signal of every platform, in one pass per source:
   * - publish outcomes of the scheduled and "publish now" paths
   *   (post_history), and of the composer's "publish now" (posts.targets,
   *   which the composer writes instead of post_history);
   * - lag of scheduled posts that went out on their first attempt, plus
   *   scheduled posts still waiting past their time;
   * - the latest profile sync of each channel.
   */
  async loadSignals(
    platforms: readonly string[],
    now: Date,
  ): Promise<Map<string, PlatformSignals>> {
    const out = new Map<string, PlatformSignals>();
    const publishSince = new Date(now.getTime() - PUBLISH_WINDOW_MS);
    const syncSince = new Date(now.getTime() - SYNC_WINDOW_MS);
    const lagFloor = new Date(now.getTime() - MAX_LAG_SAMPLE_MS);
    // A post still waiting this long past its time is a lag sample. Below
    // the recovery bar so a recovering platform still sees its stragglers.
    const overdueAfter = new Date(
      now.getTime() - DELAYED_LAG_MS * RECOVERY_FACTOR,
    );
    const list = sql.join(
      platforms.map((p) => sql`${p}`),
      sql`, `,
    );

    const history = (await this.db.execute(sql`
      SELECT ph.platform AS platform,
             p.workspace_id AS workspace_id,
             ph.action AS action,
             ph.details->>'errorMessage' AS error_message
        FROM post_history ph
        JOIN posts p ON p.id = ph.post_id
       WHERE ph.created_at >= ${publishSince}
         AND ph.action IN ('published', 'failed', 'rate_limited')
         AND ph.platform IN (${list})
    `)) as unknown as Rows<{
      platform: string;
      workspace_id: string;
      action: string;
      error_message: string | null;
    }>;
    for (const r of history.rows) {
      bucket(out, r.platform).publishes.push({
        workspaceId: r.workspace_id,
        result: r.action === 'published' ? 'published' : 'failed',
        // A history 'rate_limited' row is our limiter; its message says
        // which one (global = the platform's app limit, per-channel = one
        // account).
        errorMessage:
          r.error_message ??
          (r.action === 'rate_limited' ? 'rate limit exceeded' : null),
      });
    }

    const composer = (await this.db.execute(sql`
      SELECT t->>'platform' AS platform,
             p.workspace_id AS workspace_id,
             t->>'publishStatus' AS publish_status,
             t->>'errorCode' AS error_code,
             t->>'errorMessage' AS error_message
        FROM posts p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.targets) = 'array' THEN p.targets
               ELSE '[]'::jsonb END
        ) AS t
       WHERE p.updated_at >= ${publishSince}
         AND t->>'platform' IN (${list})
         AND t->>'publishStatus' IN ('published', 'failed')
         AND t->>'reminderSentAt' IS NULL
         AND (CASE WHEN t->>'attemptedAt' ~ ${ISO_INSTANT}
                   THEN (t->>'attemptedAt')::timestamptz END) >= ${publishSince}
    `)) as unknown as Rows<{
      platform: string;
      workspace_id: string;
      publish_status: string;
      error_code: string | null;
      error_message: string | null;
    }>;
    for (const r of composer.rows) {
      bucket(out, r.platform).publishes.push({
        workspaceId: r.workspace_id,
        result: r.publish_status === 'published' ? 'published' : 'failed',
        errorCode: r.error_code,
        errorMessage: r.error_message,
      });
    }

    // Lag of a scheduled post that went out on its FIRST attempt for that
    // channel: a publish after a failure, or after the channel was paused,
    // measures a person or a pause, not the network.
    const published = (await this.db.execute(sql`
      SELECT ph.platform AS platform,
             p.workspace_id AS workspace_id,
             (EXTRACT(EPOCH FROM (ph.created_at - p.scheduled_at)) * 1000)::bigint
               AS lag_ms
        FROM post_history ph
        JOIN posts p ON p.id = ph.post_id
       WHERE ph.created_at >= ${publishSince}
         AND ph.action = 'published'
         AND ph.platform IN (${list})
         AND p.scheduled_at IS NOT NULL
         AND p.scheduled_at >= ${lagFloor}
         AND ph.created_at >= p.scheduled_at
         AND NOT EXISTS (
           SELECT 1 FROM post_history e
            WHERE e.post_id = ph.post_id
              AND e.channel_id IS NOT DISTINCT FROM ph.channel_id
              AND e.action IN ('failed', 'rate_limited', 'held', 'published')
              AND e.created_at < ph.created_at
         )
    `)) as unknown as Rows<{
      platform: string;
      workspace_id: string;
      lag_ms: string | number;
    }>;
    for (const r of published.rows) {
      bucket(out, r.platform).lags.push({
        workspaceId: r.workspace_id,
        lagMs: Number(r.lag_ms),
      });
    }

    // Still waiting past its time: the queue has not finished it. A target
    // held for a paused channel is the customer's choice, not lag.
    const overdue = (await this.db.execute(sql`
      SELECT t->>'platform' AS platform,
             p.workspace_id AS workspace_id,
             (EXTRACT(EPOCH FROM (${now}::timestamptz - p.scheduled_at)) * 1000)::bigint
               AS lag_ms
        FROM posts p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.targets) = 'array' THEN p.targets
               ELSE '[]'::jsonb END
        ) AS t
       WHERE p.status IN ('scheduled', 'publishing')
         AND p.scheduled_at >= ${lagFloor}
         AND p.scheduled_at <= ${overdueAfter}
         AND t->>'platform' IN (${list})
         AND t->>'heldAt' IS NULL
         AND COALESCE(t->>'status', '') <> 'published'
    `)) as unknown as Rows<{
      platform: string;
      workspace_id: string;
      lag_ms: string | number;
    }>;
    for (const r of overdue.rows) {
      bucket(out, r.platform).lags.push({
        workspaceId: r.workspace_id,
        lagMs: Number(r.lag_ms),
      });
    }

    const syncs = (await this.db.execute(sql`
      SELECT c.platform AS platform,
             c.workspace_id AS workspace_id,
             s.last_profile_sync_status AS result,
             s.last_profile_sync_error AS error_message
        FROM channel_sync_state s
        JOIN social_media_channels c ON c.id = s.channel_id
       WHERE s.last_profile_sync_at >= ${syncSince}
         AND s.last_profile_sync_status IN ('success', 'failed', 'rate_limited')
         AND c.platform IN (${list})
    `)) as unknown as Rows<{
      platform: string;
      workspace_id: string;
      result: 'success' | 'failed' | 'rate_limited';
      error_message: string | null;
    }>;
    for (const r of syncs.rows) {
      bucket(out, r.platform).syncs.push({
        workspaceId: r.workspace_id,
        result: r.result,
        errorMessage: r.error_message,
      });
    }

    return out;
  }

  async loadStored(tx: Executor): Promise<Map<string, StoredStatus>> {
    const rows = await tx.select().from(platformStatus);
    return new Map(
      rows.map((r) => [
        r.platform,
        {
          platform: r.platform,
          status: r.status,
          measuredStatus: r.measuredStatus,
          measuredReason: r.measuredReason ?? null,
          reason: r.reason ?? null,
          incidentId: r.incidentId ?? null,
          signals: r.signals ?? {},
          since: r.since,
          measuredAt: r.measuredAt ?? null,
        },
      ]),
    );
  }

  async activeIncidents(tx: Executor = this.db): Promise<ActiveIncident[]> {
    const rows = await tx
      .select({
        id: platformIncidents.id,
        platform: platformIncidents.platform,
        severity: platformIncidents.severity,
        title: platformIncidents.title,
        startedAt: platformIncidents.startedAt,
      })
      .from(platformIncidents)
      .where(isNull(platformIncidents.resolvedAt));
    return rows;
  }

  /** Writes every row and the history of what changed. */
  async save(
    tx: Executor,
    rows: NextStatus[],
    changes: StatusChange[],
    now: Date,
  ): Promise<void> {
    for (const row of rows) {
      const values = {
        platform: row.platform,
        status: row.status,
        measuredStatus: row.measuredStatus,
        measuredReason: row.measuredReason,
        reason: row.reason,
        incidentId: row.incidentId,
        signals: row.signals,
        since: row.since,
        measuredAt: row.measuredAt,
        updatedAt: now,
      };
      await tx
        .insert(platformStatus)
        .values(values)
        .onConflictDoUpdate({ target: platformStatus.platform, set: values });
    }
    if (changes.length) {
      await tx.insert(platformStatusChanges).values(
        changes.map((c) => ({
          platform: c.platform,
          fromStatus: c.from,
          toStatus: c.to,
          reason: c.reason,
          incidentId: c.incidentId,
          createdAt: c.at,
        })),
      );
    }
  }

  // ------------------------------------------------------------ status page

  async statusRows(): Promise<StoredStatus[]> {
    return [...(await this.loadStored(this.db)).values()];
  }

  async changesSince(since: Date): Promise<PlatformStatusChangeRow[]> {
    return this.db
      .select()
      .from(platformStatusChanges)
      .where(gte(platformStatusChanges.createdAt, since))
      .orderBy(desc(platformStatusChanges.createdAt))
      .limit(500);
  }

  /** Unresolved incidents, newest first. */
  async openIncidents(): Promise<PlatformIncidentRow[]> {
    return this.db
      .select()
      .from(platformIncidents)
      .where(isNull(platformIncidents.resolvedAt))
      .orderBy(desc(platformIncidents.startedAt));
  }

  /** Incidents resolved since `since`, newest first. */
  async resolvedSince(since: Date): Promise<PlatformIncidentRow[]> {
    return this.db
      .select()
      .from(platformIncidents)
      .where(
        and(
          isNotNull(platformIncidents.resolvedAt),
          gte(platformIncidents.resolvedAt, since),
        ),
      )
      .orderBy(desc(platformIncidents.resolvedAt))
      .limit(100);
  }

  // -------------------------------------------------------------- incidents

  async listIncidents(
    state: 'open' | 'all',
    limit: number,
  ): Promise<PlatformIncidentRow[]> {
    const q = this.db.select().from(platformIncidents);
    return (
      state === 'open' ? q.where(isNull(platformIncidents.resolvedAt)) : q
    )
      .orderBy(desc(platformIncidents.startedAt))
      .limit(limit);
  }

  async findIncident(
    tx: Executor,
    id: string,
  ): Promise<PlatformIncidentRow | null> {
    const [row] = await tx
      .select()
      .from(platformIncidents)
      .where(eq(platformIncidents.id, id))
      .limit(1);
    return row ?? null;
  }

  async insertIncident(
    tx: Executor,
    values: typeof platformIncidents.$inferInsert,
  ): Promise<PlatformIncidentRow> {
    const [row] = await tx.insert(platformIncidents).values(values).returning();
    return row;
  }

  async updateIncident(
    tx: Executor,
    id: string,
    set: Partial<typeof platformIncidents.$inferInsert>,
  ): Promise<PlatformIncidentRow | null> {
    const [row] = await tx
      .update(platformIncidents)
      .set(set)
      .where(eq(platformIncidents.id, id))
      .returning();
    return row ?? null;
  }
}
