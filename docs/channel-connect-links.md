# Channel connect links

A workspace member with `channels:manage` sends a client a link. The client, with no Schedura account, opens `${FRONTEND_URL}/c/<token>` and connects their own social accounts into the workspace through each network's OAuth. Channels added this way carry `connect_link_id`, `added_via_link_at` and `added_via_link_email`, and `connected_by_user_id` is the sender.

Code: `src/channels/connect-links/` (sender API, public API, callback finish), shared connect logic in `src/channels/services/channel-connect.service.ts`. Migration: `drizzle/migrations/0067_channel_connect_links.sql`.

## The link

- Lifetime 7 days from creation. Resend does not extend it. A link is revoked, never deleted; status (`open`, `expired`, `revoked`) is derived.
- Networks a link may offer: `instagram`, `facebook`, `tiktok`, `linkedin`, `youtube`, `pinterest`, `threads`, `twitter` (1 to 8).
- The token is 32 random bytes, base64url (43 characters). The database stores `token_hash` (SHA-256, the only column looked up) and `token_encrypted` (so Copy link and Resend reuse the same URL). The token is redacted from logs.

## Sender API

Guards: `JwtAuthGuard`, `WorkspaceRoleGuard`, capability `channels:manage`. A `:linkId` of another workspace is a 404. Prefix `channels/workspaces/:workspaceId/connect-links`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /` | `{ networks: string[], email?: string, send: boolean }` | 201 `{ link, url }` |
| `GET /` | | `ConnectLinkDto[]` (open links only, newest first) |
| `GET /:linkId` | | `{ link, url }` (any status; Copy link) |
| `POST /:linkId/resend` | | 200 `{ link }` |
| `POST /:linkId/revoke` | | 200 `{ link }` (idempotent; connected accounts stay) |

`send: true` needs `email`, and the email is sent before the row is written, so a failed send leaves no link behind. Resend is refused for a revoked or expired link, for a link with no email, and within 60 seconds of the last send (the claim is a conditional UPDATE, so two clicks at once cannot both pass; a failed send gives the claim back). `link.connected` lists the workspace channels added through the link.

## Public API

No login: the token is the credential. Prefix `public/connect-links`. Throttled to 30 requests per minute per visitor (`X-Real-IP`, then the rightmost `X-Forwarded-For`). Skips the launch allowlist gate.

| Method and path | Response |
| --- | --- |
| `GET /:token` | Preview: workspace name, sender name and email, `expiresAt`, and per offered network the accounts already connected through the link |
| `POST /:token/:platform/start` | 200 `{ authorizationUrl }`; the OAuth state carries `connectLinkId` |
| `GET /:token/facebook/pages?selection=<id>` | The Facebook Pages (and Instagram accounts, when the link offers Instagram) of the parked sign-in. Does not use the selection up |
| `POST /:token/facebook/connect` | 201 `{ channels, skipped }` |

Every request re-checks the link: it exists, is not revoked or expired, the workspace is active and not billing-suspended, the sender is still a member with `channels:manage`, and the sender's account is not suspended (`users.is_active`). The OAuth callback re-checks it the same way before the code is exchanged.

### Facebook Pages

Facebook returns many Pages, so the callback parks the sign-in instead of connecting. Redis key `connect-link:fb-selection:<random id>` holds `{ linkId, userAccessToken }` for 900 seconds, single use. The browser is sent to `/c/<token>?selection=<id>`.

`POST /:token/facebook/connect` body: `{ selection, pageIds: string[1..25], includeInstagram: boolean }`. The selection is used up first. Response:

```json
{
  "channels": [{ "platform": "facebook", "channelId": 12, "accountName": "Acme" }],
  "skipped": [
    { "pageId": "123", "platform": "facebook" | "instagram", "code": "ALREADY_CONNECTED" | "CHANNEL_LIMIT_REACHED" | "CONNECT_FAILED" }
  ]
}
```

`skipped` has one entry per Page or Instagram account that was not connected (`platform: "instagram"` means the Page itself was connected and its Instagram account was not). The channel limit stops the run: the account it hit and every Page not tried yet are `CHANNEL_LIMIT_REACHED`. Every channel created is returned and announced to the sender even if a later step fails. When nothing was connected the answer is the refusal itself: 403 `CHANNEL_LIMIT_REACHED`, 409 `ALREADY_CONNECTED` (every skip was a duplicate), or 502 `CONNECT_FAILED`.

## OAuth flow

1. The page calls `start`, the browser goes to the network.
2. The network returns to the existing callback, `GET /channels/oauth/:platform/callback`. A state with `connectLinkId` re-checks the link, creates every channel server-side with the link mark, notifies the sender, and redirects to `/c/<token>`. No token reaches the browser.
3. Results are in the redirect query, which the page reads and strips:
   - `?connected=<platform>&channelId=<id>`
   - `?selection=<id>` (Facebook)
   - `?error=<message>&code=<CODE>`
4. X (Twitter) runs OAuth 2.0, then the OAuth 1.0a media step; the 1.0a callback also returns to `/c/<token>`. If only the 1.0a step is declined the account stays connected and the redirect is `?error=...&code=NETWORK_DECLINED`.
5. If the network answers with an error (the client cancelled), or the state fails validation, the callback still returns to `/c/<token>`. It looks the state up with `peekState`, which does not use it up and answers up to 1 hour past the state's expiry (`LINK_STATE_PEEK_GRACE_MS`), so a visitor who waited on the login screen is not sent to the team error page. Team connects (no `connectLinkId`) keep their old redirects.
6. Only the public `start` writes a link state, always for the link's own workspace and sender. The signed-in `POST /channels/workspaces/:workspaceId/oauth/initiate` keeps only the team keys of `additionalData` (`intent`; see `src/channels/lib/team-oauth-state.ts`), so a team client cannot set `connectLinkId`. As a second check, the callback (every path, including the error and expired-state exits and the X OAuth 1.0a leg) treats a state whose `connectLinkId` names a link of another workspace or another sender as an invalid state: team error page, the code is never exchanged, and the redirect never carries `/c/<token>`.

## Error codes

Body `{ statusCode, error, code, message }`; the same `code` is added as `?code=` on redirects.

| Code | Status | Meaning |
| --- | --- | --- |
| `LINK_NOT_FOUND` | 404 | No link for that token |
| `LINK_EXPIRED` | 410 | Past `expires_at` |
| `LINK_REVOKED` | 410 | Cancelled by the sender |
| `LINK_UNAVAILABLE` | 410 | Workspace suspended or inactive, the sender is no longer a member with `channels:manage`, or the sender's account is suspended |
| `NETWORK_NOT_OFFERED` | 400 | The network is not one the link offers (also at create) |
| `NO_EMAIL` | 400 | Send or resend with no email address |
| `RESEND_TOO_SOON` | 429 | Within 60 seconds of the last send |
| `EMAIL_SEND_FAILED` | 502 | The invitation email could not be sent |
| `SELECTION_EXPIRED` | 410 | The Facebook selection is missing, expired or already used |
| `CHANNEL_LIMIT_REACHED` | 403 | The workspace's channel limit (existing code) |
| `ALREADY_CONNECTED` | 409 | The workspace already has that account, healthy (the existing duplicate `ConflictException`, mapped) |
| `CONNECT_FAILED` | 502 | The network failed or refused for this account |
| `NETWORK_DECLINED` | redirect only | The client cancelled on the network's screen, or declined the X media step. Never an HTTP response |

## Google disconnect

A channel added through a link holds the client's own Google grant. When a Google channel is disconnected, `GoogleOauthRevokeService` revokes the grant only if no other channel depends on it: a link-added channel counts other Google channels with the same `connect_link_id`; a team-connected channel counts the same user's other Google channels and never counts link-added ones.
