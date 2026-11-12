import { and, desc, inArray, isNotNull } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { channelSnapshots } from '../../drizzle/schema/channel-snapshots.schema';

/**
 * Each channel's newest known follower count from our own `channel_snapshots`.
 * Snapshots with a null count (a partial sync) are skipped, so the answer is
 * the latest count we actually know. A channel with none maps to null. Every
 * requested id is present in the result. This is the figure the 100-follower
 * rule is decided on, for both the refresh job and the audience read.
 */
export async function latestFollowerCounts(
  db: DbType,
  channelIds: number[],
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (channelIds.length === 0) return out;
  for (const id of channelIds) out.set(id, null);

  const rows = await db
    .selectDistinctOn([channelSnapshots.channelId], {
      channelId: channelSnapshots.channelId,
      followersCount: channelSnapshots.followersCount,
    })
    .from(channelSnapshots)
    .where(
      and(
        inArray(channelSnapshots.channelId, channelIds),
        isNotNull(channelSnapshots.followersCount),
      ),
    )
    .orderBy(
      channelSnapshots.channelId,
      desc(channelSnapshots.snapshotDate),
      desc(channelSnapshots.fetchedAt),
    );
  for (const r of rows) out.set(Number(r.channelId), r.followersCount);
  return out;
}
