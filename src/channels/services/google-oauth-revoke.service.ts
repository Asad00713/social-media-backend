import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
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
 * Photos and Calendar. Instead we revoke only once the same connecting user
 * (`connected_by_user_id`) has no other Google channel left, counted across
 * every workspace they connected channels in — not just this one — with a
 * workspace-scoped fallback for the rare row where that column is null. The
 * YouTube DATA is deleted immediately either way, by the cascade on channel
 * deletion, so the deletion obligation is met regardless; the grant goes as
 * soon as nothing else legitimately depends on it.
 *
 * The proper structural fix is a separate OAuth client per Google service, which
 * would make revocation isolated — that requires new credentials and a reconnect
 * for every existing Google channel, so it is deliberately out of scope here.
 *
 * CONNECT LINKS: a channel added through a client's connect link
 * (`connect_link_id` set) holds the CLIENT's own Google grant, although its
 * `connected_by_user_id` is the link's sender. It is grouped by the link
 * (other Google channels with the same `connect_link_id`), and a
 * team-connected channel never counts link-added ones.
 *
 * KNOWN LIMITATIONS of the "last Google channel" check (limitation 1 below is
 * now MITIGATED for the common case; limitation 2 is unchanged and still
 * real):
 *
 * 1. Cross-workspace blind spot — MITIGATED for the same connecting user.
 *    A Google grant belongs to a Google ACCOUNT, not a workspace, so a
 *    workspace-only "other Google channel" check misses channels the same
 *    person connected in a different workspace (agency scenario: one Google
 *    account has YouTube in workspace A and Drive in workspace B). The check
 *    now also counts other Google channels with the SAME
 *    `connected_by_user_id` across every workspace, not just this one, so
 *    disconnecting YouTube in A correctly sees Drive in B and skips the
 *    revoke. This is still an approximation, not the real fix (see ROOT
 *    CAUSE below): it assumes one person's Google channels all share one
 *    Google account, which is usually true but not guaranteed. When the
 *    channel being disconnected has no `connected_by_user_id` on record
 *    (should not happen given the column's NOT NULL constraint, but legacy
 *    data could still have it), the check falls back to the old
 *    workspace-scoped behavior rather than grouping every NULL-owner channel
 *    together as if they belonged to one account.
 *
 * 2. Same-workspace, different-account false negative. Conversely, if one
 *    workspace has YouTube on Google account X and Drive on Google account Y,
 *    disconnecting YouTube counts Drive as an "other Google channel" and
 *    skips the revoke — even though X's grant has nothing left depending on
 *    it and the policy obligation to revoke it goes unmet indefinitely.
 *
 * 3. Same-account, different-app-user false positive (over-revocation) — NEW,
 *    introduced by keying on `connected_by_user_id`. If two different app
 *    users in the same workspace each connected a Google channel using the
 *    SAME Google account, the user-scoped count no longer sees the sibling
 *    channel (it belongs to a different `connected_by_user_id`), so
 *    disconnecting one will revoke the shared grant and break the other
 *    user's connection. This is over-revocation — the same class of problem
 *    as limitation 1's pre-mitigation cross-workspace bug, but much narrower,
 *    since it requires two distinct app users sharing one Google account
 *    inside one workspace.
 *
 * ROOT CAUSE: we don't store a common Google account identifier to compare
 * against, so there is no way to tell whether two Google channels in play
 * actually share a Google account. What we store in `platformAccountId` is
 * platform-specific and not comparable across platforms:
 *   - youtube: the YouTube channel id ("UC…") — channels.controller.ts:1662
 *   - google_drive: the user's email address — channels.controller.ts:4255
 *   - google_photos: a synthetic `google_photos:<workspaceId>` string —
 *     channels.controller.ts:4358
 *   - google_calendar: a synthetic `google_calendar:<workspaceId>` string
 *     (shared code path with outlook_calendar) — channels.controller.ts:760
 *
 * None of those four values can be compared to each other to prove "same
 * Google account." Fixing this properly means capturing Google's `sub` claim
 * (from the `id_token`, or via the tokeninfo endpoint) at connect time across
 * all four OAuth flows and storing it alongside the existing
 * `platformAccountId`, then keying the "last Google channel" check off that
 * instead of workspace membership. That is a separate migration effort, which
 * is why the workspace-scoped approximation stands for now.
 *
 * Never throws. A disconnect must succeed whatever Google says.
 */
@Injectable()
export class GoogleOauthRevokeService {
  private readonly logger = new Logger(GoogleOauthRevokeService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  /** Rows of a raw query, whichever shape the driver answers with. */
  private async rowsOf(query: SQL): Promise<Array<Record<string, unknown>>> {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- `db` is injected untyped */
    const result = await this.db.execute(query);
    return result?.rows ?? result ?? [];
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
  }

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
      // A Google grant belongs to a Google ACCOUNT connected by a specific
      // user, not to a workspace, so "other Google channels" must be counted
      // across every workspace that same user connected channels in — not
      // just this one. Look up who connected the channel being disconnected
      // first, then scope the count to that user. Only when that lookup
      // comes back NULL (no connecting user on record) do we fall back to
      // the old workspace-scoped approximation — grouping every NULL-owner
      // channel together as though they shared one Google account would be
      // wrong in the other direction.
      const ownerRows = await this.rowsOf(sql`
        SELECT connected_by_user_id AS connected_by_user_id,
               connect_link_id AS connect_link_id
        FROM social_media_channels
        WHERE id = ${channelId}
      `);
      const connectedByUserId =
        (ownerRows[0]?.connected_by_user_id as string | null | undefined) ??
        null;
      const connectLinkId =
        (ownerRows[0]?.connect_link_id as string | null | undefined) ?? null;

      // GOOGLE_PLATFORMS is a module constant, never user input, but pass each
      // as a bound parameter anyway rather than interpolating it into the
      // string. An IN list, not `= ANY(${array})`: drizzle spreads an array
      // parameter into a row `($1, $2, ...)` and Postgres rejects `ANY(row)`,
      // which made this count fail (and so revoke skip) every time.
      const googlePlatformList = sql.join(
        GOOGLE_PLATFORMS.map((p) => sql`${p}`),
        sql`, `,
      );
      //
      // Three groupings, by who owns the Google grant:
      //  - a channel added through a connect link belongs to the CLIENT's own
      //    Google account, so only the other channels on the same link count.
      //    Its connected_by_user_id is the link's sender, who has nothing to do
      //    with that grant.
      //  - a team-connected channel counts that user's other Google channels,
      //    never link-added ones (those hold the clients' grants, not theirs,
      //    even though the sender's id is on them).
      //  - the NULL-owner fallback is workspace-scoped, also excluding
      //    link-added channels.
      let countRows: Array<Record<string, unknown>>;
      if (connectLinkId) {
        countRows = await this.rowsOf(sql`
          SELECT COUNT(*) AS count
          FROM social_media_channels
          WHERE connect_link_id = ${connectLinkId}
            AND id <> ${channelId}
            AND platform IN (${googlePlatformList})
        `);
      } else if (connectedByUserId) {
        countRows = await this.rowsOf(sql`
          SELECT COUNT(*) AS count
          FROM social_media_channels
          WHERE connected_by_user_id = ${connectedByUserId}
            AND connect_link_id IS NULL
            AND id <> ${channelId}
            AND platform IN (${googlePlatformList})
        `);
      } else {
        countRows = await this.rowsOf(sql`
          SELECT COUNT(*) AS count
          FROM social_media_channels
          WHERE workspace_id = ${workspaceId}
            AND connect_link_id IS NULL
            AND id <> ${channelId}
            AND platform IN (${googlePlatformList})
        `);
      }
      remaining = Number(countRows[0]?.count ?? 0);
    } catch (err) {
      // If we cannot tell whether other Google channels exist, do NOT revoke —
      // wrongly revoking breaks working Drive/Photos/Calendar connections,
      // while wrongly skipping only delays the grant cleanup.
      const reason = `could not count other Google channels: ${(err as Error).message}`;
      this.logger.error(
        `Google revoke skipped for channel ${channelId} — ${reason}`,
      );
      return { revoked: false, reason };
    }

    if (remaining > 0) {
      const reason = `${remaining} other Google channel(s) still connected`;
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
        this.logger.warn(
          `Google revoke failed for channel ${channelId}: ${reason}`,
        );
        return { revoked: false, reason };
      }

      this.logger.log(
        `Google grant revoked for channel ${channelId} (${platform}) — last Google channel in workspace`,
      );
      return { revoked: true, reason: 'revoked' };
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(
        `Google revoke failed for channel ${channelId}: ${reason}`,
      );
      return { revoked: false, reason };
    }
  }
}
