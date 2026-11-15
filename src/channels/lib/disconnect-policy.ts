import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/**
 * What happens to a channel's data when the user disconnects it.
 *
 * Disconnect keeps the channel's history (insights, inbox, sync state) unless
 * the platform's developer policy says the data must go once the user
 * withdraws access - those platforms are deleted when the undo window closes.
 * Researched 2026-11-15 against each platform's current developer terms; the
 * `source` of every entry is the clause the ruling rests on. Where a policy
 * is silent on disconnect, history is kept: the user can still delete it at
 * any time ("Delete history" / "Also delete its history"), which is the
 * deletion request every policy below does require us to honour promptly.
 *
 * Re-check these when a platform's terms change. Must cover every
 * SUPPORTED_PLATFORMS member (disconnect-policy.spec.ts).
 */
export interface DisconnectPolicy {
  /** True: the history is deleted when the undo window closes. */
  mustDelete: boolean;
  /** The clause the ruling rests on. */
  source: string;
}

/** How long a disconnect can be undone before the finalize job runs. */
export const CHANNEL_RESTORE_WINDOW_MS = 10 * 60 * 1000;

const GOOGLE_YOUTUBE =
  'YouTube API Services Developer Policies III.D.2.c.1: after a user revokes consent through the API Client, delete all Authorized Data within 7 calendar days (developers.google.com/youtube/terms/developer-policies)';
const GOOGLE_SHARED_GRANT =
  'Same Google OAuth grant as YouTube (google-oauth-revoke.service.ts); the grant is revoked on finalize, so nothing can be kept or refreshed - deleted with the YouTube rule';
const META =
  'Meta Platform Terms 3.d.i: delete Platform Data promptly on the User’s request or when no longer needed for a legitimate business purpose - disconnect alone is neither (developers.facebook.com/terms)';
const NO_HISTORY =
  'Integration: no history to keep (no posts, insights or inbox) - removed as before';

export const MUST_DELETE_ON_DISCONNECT: Record<
  SupportedPlatform,
  DisconnectPolicy
> = {
  facebook: { mustDelete: false, source: META },
  instagram: { mustDelete: false, source: META },
  threads: { mustDelete: false, source: META },
  whatsapp: { mustDelete: false, source: META },
  youtube: { mustDelete: true, source: GOOGLE_YOUTUBE },
  google_business: {
    mustDelete: true,
    source:
      'Google API data under the same revoke-on-disconnect rule as YouTube (III.D.2.c); conservative until a Business Profile-specific clause says otherwise',
  },
  linkedin: {
    mustDelete: true,
    source:
      'LinkedIn API Terms 4.1 ("store Content only for the duration necessary") and Marketing API Data Storage Requirements (member social activity 48 h, organization activity only while the organization is authenticated into the app) - kept data could not be refreshed or lawfully aged after disconnect (learn.microsoft.com/linkedin/marketing/data-storage-requirements)',
  },
  pinterest: {
    mustDelete: true,
    source:
      'Pinterest Developer Guidelines: "you may not store any information accessed through any Pinterest Materials including the API", except campaign analytics about your account (policy.pinterest.com/developer-guidelines)',
  },
  tiktok: {
    mustDelete: false,
    source:
      'TikTok Developer Terms + Developer Data Sharing Agreement: no deletion-on-deauthorization clause; Annex I "Personal Data will not be kept for longer than necessary" - history kept, deletable on request (tiktok.com/legal/page/global/tiktok-data-sharing-agreement/en)',
  },
  twitter: {
    mustDelete: false,
    source:
      'X Developer Agreement and Policy, content deletion table: delete within 24 h when the user requests deletion or the content is removed on X; nothing on an app disconnect (docs.x.com/developer-guidelines)',
  },
  reddit: {
    mustDelete: true,
    source:
      'Reddit Data API Terms could not be fetched (redditinc.com blocks automated reads); Reddit requires stored content to follow deletions on Reddit and a DPA deletion SLA - conservative until verified by hand',
  },
  bluesky: {
    mustDelete: false,
    source:
      'AT Protocol: public, open network; no developer terms bind a client to delete on sign-out',
  },
  mastodon: {
    mustDelete: false,
    source:
      'Mastodon: open-source server API; no developer terms bind a client to delete on sign-out',
  },
  slack: {
    mustDelete: false,
    source:
      'Slack API Terms: limit retention of API Data from other organizations to the minimum necessary; nothing on uninstall - the workspace’s own data is kept (slack.com/terms-of-service/api)',
  },
  discord: {
    mustDelete: false,
    source:
      'Discord Developer Policy (support-dev.discord.com, July 2024): do not retain data longer than necessary, honour user requests; nothing specific to removing an app',
  },
  telegram: {
    mustDelete: false,
    source:
      'Telegram Bot Platform: the bot is the user’s own; no developer terms require deletion when it is removed from an app',
  },
  google_drive: { mustDelete: true, source: GOOGLE_SHARED_GRANT },
  google_photos: { mustDelete: true, source: GOOGLE_SHARED_GRANT },
  google_calendar: { mustDelete: true, source: GOOGLE_SHARED_GRANT },
  outlook_calendar: { mustDelete: true, source: NO_HISTORY },
  onedrive: { mustDelete: true, source: NO_HISTORY },
  dropbox: { mustDelete: true, source: NO_HISTORY },
};

/** True when disconnecting this platform must delete its history. */
export function mustDeleteOnDisconnect(platform: string): boolean {
  const policy = MUST_DELETE_ON_DISCONNECT[platform as SupportedPlatform];
  // An unknown platform is deleted: never keep data we have no ruling for.
  return policy ? policy.mustDelete : true;
}
