# YouTube API Services Compliance

What we built to satisfy the YouTube Developer Policy, and the exact disclosure
text the UI must render.

## Required disclosure

Render this wherever YouTube data appears or is connected — the settings/legal
surface and the YouTube connect flow at minimum:

> Schedura uses YouTube API Services. By connecting your YouTube channel you
> agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms). See
> the [Google Privacy Policy](https://policies.google.com/privacy) for how Google
> handles your data.

Both links are mandatory and must be live links, not plain text.

## Data retention

| Data | Policy section | What we do |
|---|---|---|
| Comment text, author display name, avatar, handle, channel id | III.E.4.c | Nulled 30 days after the comment's own timestamp, by `YoutubeRetentionService`. The inbox row survives so thread structure, reply status and counts remain. |
| View counts, subscriber counts, like counts, daily rollups | III.E.4.b | Kept indefinitely, permitted explicitly by III.E.4.b, subject to re-verifying authorization every 30 days. |

III.E.4.b permits storing analytics and statistics "for as long as is necessary",
requiring only that the client "ensure every 30 days that it is still authorized
by the user to access that data". `YoutubeAuthorizationCheckScheduler` runs
weekly and does exactly that.

The retention window is measured from the comment's own `platform_created_at`,
never from when our row was inserted — measuring from insert time would retain
expired data and destroy fresh data during any backfill.

## Revocation

| Path | Policy section | What we do |
|---|---|---|
| In-app disconnect | III.D.2.3.a | Data deleted immediately via cascade on channel delete. Google grant revoked when no other Google channel remains in the workspace. |
| Out-of-band revoke (user revokes from Google account settings) | III.D.2.3.b | Detected weekly by `YoutubeAuthorizationCheckScheduler`, which marks the channel `expired`. |
| Explicit user request | III.E.4 | `DELETE /channels/workspaces/:workspaceId/:channelId/youtube-data` removes all YouTube-derived data, analytics included, and reports the counts. |

### Why revocation is conditional

Google Drive, Google Photos and Google Calendar authenticate through the **same**
Google OAuth application as YouTube (`oauth.service.ts`, where those platforms
resolve to `envPrefix = 'YOUTUBE'`). Google merges every scope a user grants to
one API project into a single combined authorization, and its documentation is
explicit:

> If you revoke a token that represents a combined authorization, access to all
> of that authorization's scopes on behalf of the associated user are revoked
> simultaneously.

So revoking on YouTube disconnect would silently break the same user's Drive,
Photos and Calendar connections. We therefore revoke only once no other Google
channel remains in the workspace. The YouTube **data** is deleted immediately
either way, so the deletion obligation is met regardless; only the grant cleanup
waits.

The structural fix is a separate OAuth client per Google service, which would
make revocation isolated. That requires new credentials and a reconnect for every
existing Google channel, so it is deliberately deferred.

### Known limitations of the "last Google channel" check

The check that gates revocation (`GoogleOauthRevokeService.revokeIfLastGoogleChannel`)
counts other Google-platform channels **in the same workspace**. Two edge cases
were found during implementation and deliberately accepted rather than fixed:

1. **Cross-workspace blind spot.** A Google grant belongs to a Google *account*,
   not a workspace. If the same Google account has YouTube connected in
   workspace A and Google Drive connected in workspace B, disconnecting YouTube
   in A finds no other Google channel in A and revokes — silently killing
   workspace B's Drive access too, even though nobody touched B.

2. **Same-workspace, different-account false negative.** Conversely, if one
   workspace has YouTube on Google account X and Drive on Google account Y,
   disconnecting YouTube counts Drive as "another Google channel" and skips the
   revoke — even though X's grant has nothing left depending on it, so the
   revoke obligation on X goes unmet indefinitely.

**Root cause:** we don't store a common Google account identifier to compare
across platforms. `platformAccountId` is platform-specific and not comparable:
`youtube` stores the YouTube channel id, `google_drive` stores the user's email
address, and `google_photos` / `google_calendar` store synthetic
`<platform>:<workspaceId>` strings. None of these four values can prove "same
Google account."

The proper fix is capturing Google's `sub` claim (from the `id_token`, or via
the tokeninfo endpoint) at connect time across all four OAuth flows and storing
it alongside the existing `platformAccountId`, then keying the "last Google
channel" check off that instead of workspace membership. That is a separate
migration effort, which is why the workspace-scoped approximation stands for
now — it errs toward under-revoking (delaying grant cleanup) rather than
over-revoking (breaking a working connection), since a disconnect must always
succeed regardless of what Google's revoke endpoint reports.

## Quota discipline

Shipped separately as Effort A (PR #54). Inbox comment polling is bounded by a
per-video age tier and a daily unit allowance, and every YouTube API call is
gated by a per-subsystem quota allowance so background polling cannot consume the
units publishing needs. See
`docs/superpowers/plans/2026-07-18-youtube-quota-safety.md`.

## Two things not to "simplify"

1. **The retention job leaves the analytics tables alone.** That is not an
   oversight — III.E.4.b permits keeping them. The explicit deletion endpoint
   does remove them, because there the user is withdrawing authorization.
2. **The retention job filters `platform = 'youtube'`.** This obligation is
   YouTube's alone. Widening it would destroy other platforms' data for no
   reason.
