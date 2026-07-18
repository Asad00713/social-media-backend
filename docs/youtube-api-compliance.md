# YouTube API Services Compliance

What we built to satisfy the YouTube Developer Policy, and the exact disclosure
text the UI must render. B4 (disclosure) is NOT built yet — see the status note
below.

## Required disclosure

> **STATUS: NOT YET RENDERED ANYWHERE.** This wording is agreed, but no UI shows
> it. The frontend lives in a separate repository (`socialmedia-frontend`) and is
> a separate phase that has not started. **The compliance audit cannot pass until
> this is live** — B4 is the one obligation on this page that is specified but not
> built. Do not read the rest of this document as evidence that it is done.

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
| In-app disconnect | III.D.2.3.a | Data deleted immediately via cascade on channel delete. Google grant revoked when the same connecting user has no other Google channel left, in any workspace. |
| Out-of-band revoke (user revokes from Google account settings) | III.D.2.3.b | Detected weekly by `YoutubeAuthorizationCheckScheduler`, which marks the channel `expired` — but only on a genuine 401/403/`invalid_grant`, never on a network error, a Google 5xx, or quota exhaustion. |
| Explicit user request | III.E.4 | `DELETE /channels/workspaces/:workspaceId/:channelId/youtube-data` removes inbox items, post metric snapshots, channel snapshots, and channel analytics daily rows, reports the counts, and deactivates the channel so polling cannot immediately re-ingest what was just deleted. The channel's own cached `accountName` (channel title) and `profilePictureUrl` are not touched by this endpoint and remain on the `social_media_channels` row until the channel itself is deleted. |

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
Photos and Calendar connections. We therefore revoke only once **the same
connecting user** (`connected_by_user_id`) has no other Google channel left in
**any** workspace. The YouTube **data** is deleted immediately either way, so the
deletion obligation is met regardless; only the grant cleanup waits.

Where `connected_by_user_id` is null on the channel being disconnected, the check
falls back to counting within the current workspace — grouping every null row
together would wrongly treat unrelated channels as one user's.

The structural fix is a separate OAuth client per Google service, which would
make revocation isolated. That requires new credentials and a reconnect for every
existing Google channel, so it is deliberately deferred.

### Known limitations of the "last Google channel" check

The check that gates revocation (`GoogleOauthRevokeService.revokeIfLastGoogleChannel`)
counts other Google-platform channels belonging to the same `connected_by_user_id`
across all workspaces. One limitation remains:

**Same-user, different-Google-account false negative.** If one person connects
YouTube on Google account X and Drive on Google account Y, disconnecting YouTube
counts Drive as "another Google channel" and skips the revoke — even though X's
grant has nothing left depending on it, so the revoke obligation on X goes unmet
indefinitely.

This errs toward *under*-revoking: the consequence is a grant that lingers in the
user's Google Account longer than the policy wants, not a working connection
being destroyed. That is the correct direction to fail.

An earlier version of this check scoped the count to a single workspace, which
had the opposite and worse failure: one person with YouTube in workspace A and
Drive in workspace B would lose B's Drive when disconnecting A's YouTube, with no
warning to either. Keying on the connecting user rather than the workspace closed
that. Do not narrow it back to workspace scope.

**Same-Google-account, different-app-user false positive (over-revocation).**
Keying the count on `connected_by_user_id` introduces a narrower edge case in
the other direction: if two different app users in the same workspace each
connected a Google channel using the **same** Google account, the user-scoped
count no longer sees the sibling channel (it belongs to a different
`connected_by_user_id`), so disconnecting one will revoke the shared Google
grant and break the other user's connection. This is over-revocation — the
same class of problem as the cross-workspace bug this scoping replaced, but
much narrower, since it requires two distinct app users sharing one Google
account inside one workspace.

**Root cause:** we don't store a common Google account identifier to compare
across platforms. `platformAccountId` is platform-specific and not comparable:
`youtube` stores the YouTube channel id, `google_drive` stores the user's email
address, and `google_photos` / `google_calendar` store synthetic
`<platform>:<workspaceId>` strings. None of these four values can prove "same
Google account."

The proper fix is capturing Google's `sub` claim (from the `id_token`, or via
the tokeninfo endpoint) at connect time across all four OAuth flows and storing
it alongside the existing `platformAccountId`, then keying the "last Google
channel" check off the actual Google account rather than the connecting user.
That is a separate effort; the `connected_by_user_id` approximation covers the
realistic cases until then.

A disconnect always succeeds regardless of what Google's revoke endpoint reports —
the user's intent to disconnect wins, and a revoke failure is logged, never raised.

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
