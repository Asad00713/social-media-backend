import type { BrandProfileRow } from '../../drizzle/schema/workspace-brand-profile.schema';
import type {
  FirstWeekDraft,
  FirstWeekProfileView,
  SkipReason,
} from '../first-week.types';
import { IMAGE_REQUIRED_PLATFORMS } from './first-week-targets';

/** The columns of a `posts` row the first-week view needs (a PostRow is assignable). */
export interface FirstWeekPostLike {
  id: string;
  status: string;
  content: string | null;
  mediaItems: unknown;
  targets: unknown;
  scheduledAt: Date | null;
  metadata: unknown;
}

const meta = (row: FirstWeekPostLike): Record<string, unknown> =>
  row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};

export function slotOf(row: FirstWeekPostLike): number | null {
  const slot = meta(row).firstWeekSlot;
  return Number.isInteger(slot) ? (slot as number) : null;
}

/**
 * Why a draft cannot be scheduled right now, or null. The order is the
 * order a person would fix things in, and `already_scheduled` wins because
 * nothing else matters for a post that has already left 'draft'.
 */
export function blockedReasonOf(
  d: {
    status: string;
    targets: unknown[];
    hasMedia: boolean;
    platforms: string[];
    suggestedAt: Date;
  },
  now: Date,
): SkipReason | null {
  if (d.status !== 'draft') return 'already_scheduled';
  if (d.targets.length === 0) return 'no_targets';
  const needsImage = d.platforms.some((p) =>
    (IMAGE_REQUIRED_PLATFORMS as readonly string[]).includes(p),
  );
  if (needsImage && !d.hasMedia) return 'needs_image';
  if (d.suggestedAt.getTime() <= now.getTime()) return 'past';
  return null;
}

export function toDraftView(
  row: FirstWeekPostLike,
  now: Date,
): FirstWeekDraft | null {
  const slot = slotOf(row);
  const suggestedRaw = meta(row).suggestedAt;
  const suggestedAt =
    typeof suggestedRaw === 'string' ? new Date(suggestedRaw) : null;
  if (slot === null || !suggestedAt || Number.isNaN(suggestedAt.getTime())) {
    return null;
  }

  const rawTargets: unknown[] = Array.isArray(row.targets) ? row.targets : [];
  const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
  const targets = rawTargets.map((t) => {
    const target = (t ?? {}) as { platform?: unknown; channelId?: unknown };
    return {
      platform: asText(target.platform),
      channelId: asText(target.channelId),
    };
  });
  const media: unknown[] = Array.isArray(row.mediaItems) ? row.mediaItems : [];
  const firstUrl = (media[0] as { url?: unknown } | null | undefined)?.url;
  const mediaUrl = typeof firstUrl === 'string' ? firstUrl : null;

  const blockedReason = blockedReasonOf(
    {
      status: row.status,
      targets,
      hasMedia: mediaUrl !== null,
      platforms: targets.map((t) => t.platform),
      suggestedAt,
    },
    now,
  );

  return {
    id: row.id,
    status: row.status === 'draft' ? 'draft' : 'scheduled',
    slot,
    suggestedAt: suggestedAt.toISOString(),
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    caption: row.content ?? '',
    mediaUrl,
    targets,
    schedulable: blockedReason === null,
    blockedReason,
  };
}

export function toProfileView(row: BrandProfileRow): FirstWeekProfileView {
  return {
    sells: row.sells,
    voice: row.voice ?? [],
    audience: row.audience,
    source: row.source,
    sourceChannelId: row.sourceChannelId ?? null,
    sourcePlatform: row.sourcePlatform,
    postsRead: row.postsRead,
    status: row.status,
    draftedCount: row.draftedCount,
    weekStartsOn: row.weekStartsOn,
    weekEndsAt: row.weekEndsAt ? row.weekEndsAt.toISOString() : null,
    error: row.error,
  };
}
