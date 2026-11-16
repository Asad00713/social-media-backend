import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PlatformState } from '../../drizzle/schema/platform-status.schema';

/**
 * The platforms the status page reports on: every network the app publishes
 * to (PublisherFactory) that a customer can connect today. Reddit has a
 * publisher but no way to connect it, so it would only ever read
 * "operational". Integrations (Drive, calendars...) never publish.
 * Order is the order the status page lists them in.
 */
export const STATUS_PLATFORMS = [
  'instagram',
  'facebook',
  'threads',
  'twitter',
  'linkedin',
  'tiktok',
  'youtube',
  'pinterest',
  'bluesky',
  'mastodon',
  'slack',
  'discord',
] as const satisfies readonly SupportedPlatform[];

export type StatusPlatform = (typeof STATUS_PLATFORMS)[number];

export function isStatusPlatform(value: unknown): value is StatusPlatform {
  return (
    typeof value === 'string' &&
    (STATUS_PLATFORMS as readonly string[]).includes(value)
  );
}

const RANK: Record<PlatformState, number> = {
  operational: 0,
  delayed: 1,
  outage: 2,
};

/** Orders states by how bad they are. */
export function stateRank(state: PlatformState): number {
  return RANK[state];
}

/** The worse of two states. */
export function worstState(a: PlatformState, b: PlatformState): PlatformState {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The line a customer reads under each state. It says what the app does,
 * not what the network does: a delayed platform still gets every post, a
 * little late; while a platform is down a publish fails (the scheduled path
 * does not retry a failed channel by itself), so the customer retries.
 */
export const STATE_MESSAGES: Record<PlatformState, string> = {
  operational: 'Posts are going out on time.',
  delayed: 'Posts may go out a few minutes late.',
  outage: 'Posts may fail until it’s back. You can retry them then.',
};
