import { createHash } from 'node:crypto';

/** posts.metadata.source for a post Maestro drafted for the first week. */
export const FIRST_WEEK_SOURCE = 'first_week';

/**
 * A stable uuid per (workspace, slot), shaped as a version-5 uuid.
 *
 * Using it as the draft's primary key makes "never create a second draft for a
 * slot" a database guarantee (INSERT ... ON CONFLICT DO NOTHING) instead of a
 * read-then-write race between two runs.
 */
export function firstWeekDraftId(workspaceId: string, slot: number): string {
  const h = createHash('sha1')
    .update(`first-week:${workspaceId}:${slot}`)
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const CARRIED_KEYS = ['firstWeekSlot', 'suggestedAt', 'imageCredit'] as const;

/**
 * The first-week keys of an existing post's metadata, or {} for any other post.
 *
 * The composer rewrites `posts.metadata` wholesale on every save and every
 * schedule. Without this, editing a first-week draft would erase its tag and
 * the post would drop out of the first-week list. Spread the result AFTER the
 * composer's own keys so `source: 'first_week'` wins over `source: 'composer'`.
 */
export function carryFirstWeekMeta(existing: unknown): Record<string, unknown> {
  if (!existing || typeof existing !== 'object') return {};
  const meta = existing as Record<string, unknown>;
  if (meta.source !== FIRST_WEEK_SOURCE) return {};
  const out: Record<string, unknown> = { source: FIRST_WEEK_SOURCE };
  for (const key of CARRIED_KEYS) {
    if (meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}
