import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

/**
 * Platforms that authenticate through our single Google OAuth application.
 * See oauth.service.ts, where google_drive / google_photos / google_calendar
 * all resolve to envPrefix 'YOUTUBE'.
 */
export const GOOGLE_PLATFORMS: readonly string[] = [
  'youtube',
  'google_drive',
  'google_photos',
  'google_calendar',
];

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface RevokeOutcome {
  revoked: boolean;
  reason: string;
}

/**
 * Revokes our Google OAuth grant when a Google channel is disconnected.
 *
 * YouTube Developer Policy III.D.2.3.a requires an in-app disconnect to revoke
 * immediately. Nothing in this codebase did that before — the grant survived in
 * the user's Google Account after they disconnected.
 *
 * THE CATCH, and why this is not just a fetch call:
 *
 * Drive, Photos and Calendar share the YouTube OAuth application. Google merges
 * every scope a user grants to one API project into a single combined
 * authorization, and revoking any token from it takes down ALL of those scopes
 * at once — Google's own words: "If you revoke a token that represents a
 * combined authorization, access to all of that authorization's scopes on
 * behalf of the associated user are revoked simultaneously."
 *
 * So revoking on YouTube disconnect would silently break the same user's Drive,
 * Photos and Calendar. Instead we revoke only once no other Google channel is
 * left in the workspace. The YouTube DATA is deleted immediately either way, by
 * the cascade on channel deletion, so the deletion obligation is met regardless;
 * the grant goes as soon as nothing else legitimately depends on it.
 *
 * The proper structural fix is a separate OAuth client per Google service, which
 * would make revocation isolated — that requires new credentials and a reconnect
 * for every existing Google channel, so it is deliberately out of scope here.
 *
 * Never throws. A disconnect must succeed whatever Google says.
 */
@Injectable()
export class GoogleOauthRevokeService {
  private readonly logger = new Logger(GoogleOauthRevokeService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async revokeIfLastGoogleChannel(
    channelId: number,
    workspaceId: string,
    platform: string,
    accessToken: string,
  ): Promise<RevokeOutcome> {
    if (!GOOGLE_PLATFORMS.includes(platform)) {
      return { revoked: false, reason: 'not a Google platform' };
    }

    let remaining: number;
    try {
      // GOOGLE_PLATFORMS is a module constant, never user input, but pass it as
      // a bound parameter anyway rather than interpolating it into the string.
      const result: any = await this.db.execute(sql`
        SELECT COUNT(*) AS count
        FROM social_media_channels
        WHERE workspace_id = ${workspaceId}
          AND id <> ${channelId}
          AND platform = ANY(${[...GOOGLE_PLATFORMS]})
      `);
      const rows = result?.rows ?? result ?? [];
      remaining = Number(rows[0]?.count ?? 0);
    } catch (err) {
      // If we cannot tell whether other Google channels exist, do NOT revoke —
      // wrongly revoking breaks working Drive/Photos/Calendar connections,
      // while wrongly skipping only delays the grant cleanup.
      const reason = `could not count other Google channels: ${(err as Error).message}`;
      this.logger.error(`Google revoke skipped for channel ${channelId} — ${reason}`);
      return { revoked: false, reason };
    }

    if (remaining > 0) {
      const reason = `${remaining} other Google channel(s) still connected in this workspace`;
      this.logger.log(
        `Google revoke skipped for channel ${channelId} (${platform}) — ${reason}. ` +
          `Revoking would take down the shared grant for all of them. ` +
          `Channel data is still deleted immediately.`,
      );
      return { revoked: false, reason };
    }

    try {
      const res = await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });

      if (!res.ok) {
        const body = await res.text();
        const reason = `Google revoke returned ${res.status}: ${body}`;
        // Best effort, exactly like MastodonService.revokeToken — never throw.
        this.logger.warn(`Google revoke failed for channel ${channelId}: ${reason}`);
        return { revoked: false, reason };
      }

      this.logger.log(
        `Google grant revoked for channel ${channelId} (${platform}) — last Google channel in workspace`,
      );
      return { revoked: true, reason: 'revoked' };
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`Google revoke failed for channel ${channelId}: ${reason}`);
      return { revoked: false, reason };
    }
  }
}
