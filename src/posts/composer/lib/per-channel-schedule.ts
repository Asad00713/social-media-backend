import { BadRequestException } from '@nestjs/common';
import type { ChannelTarget, PlatformOverrides } from '../types/draft.types';

/**
 * "Different time for each channel" (composer schedule picker, #43).
 *
 * One `posts` row has one publish job, so a draft whose channels go out at
 * different times is split at schedule time into sibling rows, one per
 * distinct instant. Each sibling is an ordinary scheduled post afterwards:
 * the publishing pipeline (processor, PostService.publishPost, orchestrator)
 * never learns that it was split, which is the point.
 *
 * The siblings share `metadata[SCHEDULE_GROUP_KEY]` so they can be found as
 * a family. Nothing reads the key for behaviour today.
 *
 * DECISION — edits stay per sibling. Unscheduling, moving or editing one
 * sibling affects only that row. To make an edit group-wide later, change
 * `SCHEDULE_GROUP_EDITS` to 'group' and branch on it where a scheduled post
 * is cancelled or moved: `ComposerSchedulingService.cancel` and
 * `PostService.updatePost` / `deletePost`, by selecting every row whose
 * `metadata->>'scheduleGroupId'` matches.
 */
export const SCHEDULE_GROUP_KEY = 'scheduleGroupId' as const;
export const SCHEDULE_GROUP_EDITS: 'sibling' | 'group' = 'sibling';

/** The schedule modes a schedule request may name. */
export const SCHEDULE_REQUEST_MODES = ['all_same_time', 'per_channel'] as const;
export type ScheduleRequestMode = (typeof SCHEDULE_REQUEST_MODES)[number];

/** The earliest a scheduled post may fire, from now (the existing 5s rule). */
export const MIN_SCHEDULE_LEAD_MS = 5_000;

export const PER_CHANNEL_WITH_REPEAT =
  'A repeating post goes out at one time. Turn off "Different time for each channel" or the repeat.';

/** The channels that go out at one instant. */
export interface ScheduleGroup {
  at: Date;
  channels: ChannelTarget[];
}

function assertFuture(at: Date, what: string): void {
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException(`${what} is not a valid date`);
  }
  if (at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    throw new BadRequestException(
      `${what} must be at least 5 seconds in the future`,
    );
  }
}

/**
 * The instants a schedule request goes out at, earliest first, each with
 * its channels.
 *
 * Without `per_channel` every channel goes at `scheduledAt` (one group —
 * the schedule as it always was; a channel's own `scheduleAt` is ignored,
 * as it always was). With it, every channel must carry its own future
 * `scheduleAt`, and channels sharing an instant share a group.
 */
export function groupByInstant(
  mode: ScheduleRequestMode | undefined,
  scheduledAt: string,
  channels: ChannelTarget[],
): ScheduleGroup[] {
  if (mode !== 'per_channel') {
    const at = new Date(scheduledAt);
    assertFuture(at, 'scheduledAt');
    return [{ at, channels }];
  }

  const byTime = new Map<number, ScheduleGroup>();
  for (const channel of channels) {
    if (!channel.scheduleAt) {
      throw new BadRequestException(
        `Channel ${channel.channelId} has no time. With a time per channel, every channel needs one.`,
      );
    }
    const at = new Date(channel.scheduleAt);
    assertFuture(at, `The time for channel ${channel.channelId}`);
    const key = at.getTime();
    const group = byTime.get(key);
    if (group) group.channels.push(channel);
    else byTime.set(key, { at, channels: [channel] });
  }
  return [...byTime.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * The per-platform content of only the platforms these channels are on —
 * their captions, settings, first comments, threads and media. Two
 * channels on one platform share its entry, so both siblings carry it.
 */
export function overridesFor(
  perPlatform: PlatformOverrides | undefined,
  channels: ChannelTarget[],
): PlatformOverrides {
  const platforms = new Set(channels.map((c) => c.platform));
  const out: Record<string, unknown> = {};
  for (const [platform, override] of Object.entries(perPlatform ?? {})) {
    if (platforms.has(platform as ChannelTarget['platform'])) {
      out[platform] = override;
    }
  }
  return out as PlatformOverrides;
}

/** The family id a post already belongs to, if it was split before. */
export function readScheduleGroup(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const id = (metadata as Record<string, unknown>)[SCHEDULE_GROUP_KEY];
  return typeof id === 'string' && id ? id : null;
}

/**
 * The family key to write back when a post's metadata is rewritten
 * wholesale (every composer save and schedule does), so re-scheduling one
 * sibling does not quietly drop it from its family. {} when it has none.
 */
export function carryScheduleGroup(metadata: unknown): Record<string, string> {
  const id = readScheduleGroup(metadata);
  return id ? { [SCHEDULE_GROUP_KEY]: id } : {};
}
