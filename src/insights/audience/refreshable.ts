/**
 * The one rule for "may we call the platform for this channel's audience?".
 * A paused (`isActive=false`) or not-connected (expired, revoked...) channel
 * has no usable token: the daily cron skips it, the handler skips it and the
 * read never enqueues it, so its stored demographics survive untouched.
 */
export function isAudienceRefreshable(c: {
  isActive: boolean;
  connectionStatus: string;
}): boolean {
  return c.isActive && c.connectionStatus === 'connected';
}
