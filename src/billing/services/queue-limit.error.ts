import { ForbiddenException } from '@nestjs/common';

export const QUEUE_LIMIT_REACHED = 'QUEUE_LIMIT_REACHED' as const;

/**
 * The 403 for "this channel's scheduling queue is full".
 *
 * Modelled on `channelLimitReached`: the body keeps Nest's standard
 * `{ statusCode, error, message }` and adds a machine-readable `code` with the
 * numbers. The code is what lets a client tell a quota apart from a transient
 * failure — the Planner offered a "Try again" button on this refusal, which
 * could never succeed, because an uncoded 403 is indistinguishable from a
 * network blip.
 */
export function queueLimitReached(
  channelId: string,
  queued: number,
  limit: number,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: QUEUE_LIMIT_REACHED,
    channelId,
    queued,
    limit,
    message:
      `Scheduling queue full for channel ${channelId}. ` +
      `This channel has ${queued} of ${limit} scheduled posts. ` +
      'Publish or remove a scheduled post, or upgrade for unlimited scheduling.',
  });
}
