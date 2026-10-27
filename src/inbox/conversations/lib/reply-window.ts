import type { ConversationKind } from './thread-key';

export const WINDOW_PLATFORMS = ['facebook', 'instagram', 'whatsapp'] as const;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLOSING_MS = 60 * 60 * 1000;

export type ReplyWindowState = 'none' | 'open' | 'closing' | 'closed';

/** lastInboundAt + 24h for a DM on a window platform, else null. */
export function replyWindowClosesAt(
  platform: string,
  kind: ConversationKind,
  lastInboundAt: Date | null,
): Date | null {
  if (kind !== 'dm' || lastInboundAt === null) return null;
  if (!(WINDOW_PLATFORMS as readonly string[]).includes(platform)) return null;
  return new Date(lastInboundAt.getTime() + WINDOW_MS);
}

export function replyWindowState(
  closesAt: Date | null,
  now: Date,
): ReplyWindowState {
  if (closesAt === null) return 'none';
  const remaining = closesAt.getTime() - now.getTime();
  if (remaining <= 0) return 'closed';
  if (remaining < CLOSING_MS) return 'closing';
  return 'open';
}

export function sendLaterCap(
  closesAt: Date | null,
  now: Date,
): { latestSendLaterAt: string | null; canSendLater: boolean } {
  const state = replyWindowState(closesAt, now);
  return {
    latestSendLaterAt:
      closesAt === null
        ? null
        : new Date(closesAt.getTime() - 60_000).toISOString(),
    canSendLater: state !== 'closing' && state !== 'closed',
  };
}
