/**
 * BullMQ deduplication id for one channel's inbox poll. Must not contain a
 * colon: BullMQ rejects custom ids with `:` (this repo has crashed on that).
 */
export function pollDedupId(channelId: number): string {
  return `inbox-poll-${channelId}`;
}
