import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import {
  QUEUE_HORIZON_DAYS,
  QUEUE_MIN_LEAD_MS,
  minuteKey,
  pickQueueSlots,
  upcomingSlotInstants,
  type QueueSlot,
} from '../lib/queue-slots';
import { loadWorkspaceTimezone } from '../lib/workspace-time';
import { PlannerPreferencesService } from './planner-preferences.service';

const DAY_MS = 86_400_000;

export interface QueueDto {
  timezone: string;
  slots: QueueSlot[];
  /** ISO instant of the first slot no scheduled post holds; null if none. */
  nextFree: string | null;
  /** ISO instant of the first slot when it is still free; null otherwise. */
  top: string | null;
}

export interface QueueQuery {
  /** The draft's channels. A slot is taken only by a post on one of them. */
  channelIds: string[];
  /** The draft itself, so its own time never counts against it. */
  excludePostId?: string;
}

/**
 * The composer's "Your queue" rows: the caller's weekly slots (Planner
 * preferences), minus the slots already held by a scheduled post.
 *
 * Read-only. Picking a slot sets the draft's time like any picked time; the
 * schedule endpoint does the rest, so nothing here touches a job.
 */
@Injectable()
export class QueueSlotsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly preferences: PlannerPreferencesService,
  ) {}

  async get(
    workspaceId: string,
    userId: string,
    query: QueueQuery,
    now = new Date(),
  ): Promise<QueueDto> {
    const [timezone, prefs] = await Promise.all([
      loadWorkspaceTimezone(this.db, workspaceId),
      this.preferences.get(userId, workspaceId),
    ]);
    const slots = prefs.queueSlots;
    const instants = upcomingSlotInstants(slots, timezone, now);
    if (instants.length === 0) {
      return { timezone, slots, nextFree: null, top: null };
    }

    const taken = await this.takenMinutes(workspaceId, query, now);
    const pick = pickQueueSlots(instants, taken);
    return {
      timezone,
      slots,
      nextFree: pick.nextFree?.toISOString() ?? null,
      top: pick.top?.toISOString() ?? null,
    };
  }

  /** Minute keys of scheduled posts that share a channel with the draft. */
  private async takenMinutes(
    workspaceId: string,
    query: QueueQuery,
    now: Date,
  ): Promise<Set<number>> {
    const rows = await this.db
      .select({
        id: posts.id,
        scheduledAt: posts.scheduledAt,
        targets: posts.targets,
      })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          gte(
            posts.scheduledAt,
            new Date(now.getTime() + QUEUE_MIN_LEAD_MS - 60_000),
          ),
          lte(
            posts.scheduledAt,
            new Date(now.getTime() + (QUEUE_HORIZON_DAYS + 1) * DAY_MS),
          ),
        ),
      );
    return takenMinuteKeys(rows, query);
  }
}

/**
 * Which minutes are held, for these channels. With no channels picked yet,
 * every scheduled post in the workspace holds its slot - the conservative
 * answer, since the queue cannot know where the post will go.
 */
export function takenMinuteKeys(
  rows: ReadonlyArray<{
    id: string;
    scheduledAt: Date | null;
    targets: ReadonlyArray<{ channelId: string | number }> | null;
  }>,
  query: QueueQuery,
): Set<number> {
  const wanted = new Set(query.channelIds.map(String));
  const taken = new Set<number>();
  for (const row of rows) {
    if (!row.scheduledAt) continue;
    if (query.excludePostId && row.id === query.excludePostId) continue;
    const shares =
      wanted.size === 0 ||
      (row.targets ?? []).some((t) => wanted.has(String(t.channelId)));
    if (shares) taken.add(minuteKey(new Date(row.scheduledAt)));
  }
  return taken;
}
