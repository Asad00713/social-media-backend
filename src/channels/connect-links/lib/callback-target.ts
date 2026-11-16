import { ConflictException } from '@nestjs/common';
import { errorCodeOf } from '../../../billing/services/channel-limit.error';

/**
 * Where the OAuth callback sends the browser when it is done.
 *
 * A team connect (popup from the dialog) goes to the frontend's
 * `/channels/connect/success|error` pages - these strings are the ones the
 * callback has always built, byte for byte. A connect started from a client's
 * link page (`/c/<token>`) goes back to that page with the result in the
 * query; the page reads it, then strips it.
 */
export interface CallbackTarget {
  /** True when the result goes back to a connect link page. */
  readonly isLink: boolean;
  success(platform: string, channelId: number): string;
  /** Facebook on a link: the page opens its Pages picker for this selection. */
  selection(id: string): string;
  /**
   * `code` is added when there is one. `description` is a team-page extra
   * (the link page ignores it).
   */
  error(message: string, code?: string | null, description?: string): string;
}

/**
 * The visitor cancelled or declined on the network's own login screen. Only
 * ever a redirect code (there is no HTTP refusal behind it).
 */
export const NETWORK_DECLINED = 'NETWORK_DECLINED';

/**
 * X on a link: the account was connected by the OAuth 2.0 leg, but the
 * OAuth 1.0a (media upload) leg did not finish - declined, or the request
 * token could not be had. Sent with NETWORK_DECLINED.
 */
export const X_MEDIA_DECLINED_MESSAGE =
  'X media uploads were not allowed. The account is connected without them.';

/**
 * The callback's query as it may be logged: the state is shortened the way
 * the callback already logs it, the authorization code is never written.
 */
export function redactCallbackQuery(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  if (typeof out.state === 'string') {
    out.state = `${out.state.substring(0, 10)}...`;
  }
  if (out.code !== undefined) out.code = '[redacted]';
  return out;
}

export function callbackTarget(ctx: {
  frontendUrl: string;
  linkRaw: string | null;
}): CallbackTarget {
  const { frontendUrl, linkRaw } = ctx;
  const enc = encodeURIComponent;

  if (linkRaw) {
    const page = `${frontendUrl}/c/${enc(linkRaw)}`;
    return {
      isLink: true,
      success: (platform, channelId) =>
        `${page}?connected=${enc(platform)}&channelId=${channelId}`,
      selection: (id) => `${page}?selection=${enc(id)}`,
      error: (message, code) =>
        `${page}?error=${enc(message)}${code ? `&code=${enc(code)}` : ''}`,
    };
  }

  return {
    isLink: false,
    success: (platform, channelId) =>
      `${frontendUrl}/channels/connect/success?platform=${platform}&channelId=${channelId}`,
    selection: () => {
      // Only a link parks a Facebook token server-side; the team dialog gets
      // the token and lists the Pages itself.
      throw new Error('A Facebook selection exists only for a connect link');
    },
    error: (message, code, description) =>
      `${frontendUrl}/channels/connect/error?error=${enc(message)}` +
      (description !== undefined ? `&description=${enc(description)}` : '') +
      (code ? `&code=${enc(code)}` : ''),
  };
}

/**
 * The `code` a link page gets for a failed connect: the coded refusal's own
 * code (CHANNEL_LIMIT_REACHED, LINK_REVOKED, ...), and ALREADY_CONNECTED for
 * the healthy-duplicate ConflictException of `createChannel`.
 */
export function linkErrorCodeOf(err: unknown): string | null {
  const code = errorCodeOf(err);
  if (code) return code;
  return err instanceof ConflictException ? 'ALREADY_CONNECTED' : null;
}

/** The connect link a stored OAuth state was started from, if any. */
export function connectLinkIdOf(
  additionalData: Record<string, unknown> | null | undefined,
): string | null {
  const id = additionalData?.connectLinkId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
