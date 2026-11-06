import { Injectable } from '@nestjs/common';
import { BlueskyService } from './bluesky.service';

/** The answer the composer's mention menu shows beside a typed handle. */
export interface MentionLookupResult {
  /** The handle as checked, without its `@`. */
  handle: string;
  /** Whether the network knows an account by that handle. */
  found: boolean;
  displayName?: string;
  avatarUrl?: string;
}

/** The networks a typed handle can be checked on cheaply. */
export const MENTION_LOOKUP_PLATFORMS = ['bluesky', 'mastodon'] as const;
export type MentionLookupPlatform = (typeof MENTION_LOOKUP_PLATFORMS)[number];

/**
 * Checks a handle someone typed in the composer's `@` menu, for an account
 * outside the workspace — on the two networks where one cheap call answers
 * it with the channel's own credentials:
 *
 * - Bluesky: `app.bsky.actor.getProfile` takes a handle as `actor`
 *   (lexicon: "Handle or DID of account to fetch profile of") and fails
 *   for one that does not resolve.
 * - Mastodon: `GET /api/v2/search?type=accounts&resolve=true` — with
 *   `resolve`, a remote `user@server` is looked up over WebFinger (stated,
 *   docs.joinmastodon.org/methods/search). Needs `read:search`, which our
 *   `read` scope covers.
 *
 * Elsewhere the composer inserts the handle as typed and says it was not
 * checked: X's user lookup costs API quota per call on a paid tier, and
 * Meta's networks offer no handle lookup to a publishing app.
 */
@Injectable()
export class MentionLookupService {
  constructor(private readonly blueskyService: BlueskyService) {}

  /** A handle as the networks spell it: no leading `@`, trimmed. */
  static normalize(handle: string): string {
    return handle.trim().replace(/^@+/, '');
  }

  async lookup(
    platform: MentionLookupPlatform,
    accessToken: string,
    channelMetadata: Record<string, any> | null | undefined,
    rawHandle: string,
  ): Promise<MentionLookupResult> {
    const handle = MentionLookupService.normalize(rawHandle);
    if (!handle) return { handle, found: false };
    return platform === 'bluesky'
      ? this.lookupBluesky(accessToken, handle)
      : this.lookupMastodon(accessToken, channelMetadata, handle);
  }

  private async lookupBluesky(
    accessJwt: string,
    handle: string,
  ): Promise<MentionLookupResult> {
    try {
      const profile = await this.blueskyService.getProfile(accessJwt, handle);
      return {
        handle: profile.handle,
        found: true,
        displayName: profile.displayName ?? undefined,
        avatarUrl: profile.avatar ?? undefined,
      };
    } catch {
      // getProfile throws for an unknown handle; a network hiccup reads the
      // same, and the composer only ever says "not found" — it never blocks.
      return { handle, found: false };
    }
  }

  private async lookupMastodon(
    accessToken: string,
    channelMetadata: Record<string, any> | null | undefined,
    handle: string,
  ): Promise<MentionLookupResult> {
    const instanceUrl: unknown = channelMetadata?.instanceUrl;
    if (typeof instanceUrl !== 'string' || !instanceUrl) {
      return { handle, found: false };
    }
    const base = /^https?:\/\//i.test(instanceUrl)
      ? instanceUrl.replace(/\/+$/, '')
      : `https://${instanceUrl.replace(/\/+$/, '')}`;
    const url = new URL(`${base}/api/v2/search`);
    url.searchParams.set('q', handle);
    url.searchParams.set('type', 'accounts');
    url.searchParams.set('resolve', 'true');
    url.searchParams.set('limit', '1');

    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return { handle, found: false };
      const data = (await response.json()) as {
        accounts?: Array<{
          acct?: string;
          display_name?: string;
          avatar?: string;
        }>;
      };
      const account = data.accounts?.[0];
      // Search is fuzzy: only an exact `acct` match is the account typed.
      // A local account's acct is `user`, a remote one's `user@server` —
      // so `user@<this server>` is compared without its own host.
      const ownHost = new URL(base).hostname.toLowerCase();
      const typed = handle.toLowerCase().replace(`@${ownHost}`, '');
      if (!account?.acct || account.acct.toLowerCase() !== typed) {
        return { handle, found: false };
      }
      return {
        handle: account.acct,
        found: true,
        displayName: account.display_name || undefined,
        avatarUrl: account.avatar || undefined,
      };
    } catch {
      return { handle, found: false };
    }
  }
}
