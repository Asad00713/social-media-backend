# Meta App Review — Ads Phase 1

## Permissions to request

| Permission | Required? | Screencast in 2026? |
|---|---|---|
| `ads_management` | YES | NO (May 4, 2026 update — no screencast required for this permission) |
| `ads_read` | YES | NO |
| `leads_retrieval` | YES (Lead Ads only) | YES |
| `pages_manage_ads` | YES | YES |
| `business_management` | YES | YES |

## Use case description template

> Schedura is a social-media-operations SaaS that helps business owners manage their advertising. Users connect their own Meta Page and ad account to Schedura, then use our wizard to (1) boost existing Page posts and (2) create Lead Ads with custom forms. Leads captured by these forms are surfaced in the user's Schedura Inbox and optionally routed via email or HMAC-signed webhook to the user's CRM. We do not run ads on behalf of users without explicit per-campaign action. Charges accrue to the user's own Meta ad account via Meta's existing payment methods.

## Screencast script (required for `leads_retrieval`, `pages_manage_ads`, `business_management`)

1. Show `/login` + sign in.
2. Navigate to `/w/:wid/settings/ad-accounts` → show "Connect Meta Ad Account" CTA.
3. Click → complete OAuth → ad accounts appear after redirect.
4. Sidebar → Ads → click "New ad" button.
5. Wizard: pick **Meta** card → pick ad account → pick **Generate Leads** objective.
6. Build lead form (FULL_NAME + EMAIL + privacy URL pointing to the hosted marketing site privacy page).
7. Configure routing (toggle email destination + add address).
8. Click "Publish to Meta" → land on detail page with `ACTIVE` status badge.
9. Open Meta Lead Ads Testing Tool at `https://developers.facebook.com/tools/lead-ads-testing` → select the Page → select the newly-created form → click "Create Lead".
10. Return to `/w/:wid/ads/leads` — new row appears within 5 seconds (SSE).
11. Inbox bell shows the toast notification "New lead captured".

## Pre-submit checklist

- [ ] App is on Business verification track (not Individual)
- [ ] **Privacy Policy URL** live on the marketing website (Phase 1: hosted separately, not in this app per scope decision 2026-05-29) — confirm URL accessible without login
- [ ] Data Use Checkup completed in App Dashboard
- [ ] All requested permissions enabled in App Console → App Review → Permissions and Features
- [ ] Test user added if reviewer needs to log in to a sandbox account
- [ ] Demo video uploaded for each screencast-required permission (≤ 5 min each, English-language UI)
- [ ] Webhook callback URL points to production HTTPS endpoint (not ngrok)
- [ ] `subscribed_fields=leadgen,messages,messaging_postbacks` confirmed via `GET /{page_id}/subscribed_apps`
- [ ] At least one test campaign has been created and a test lead has been captured end-to-end in production

## Operational notes

**`channels` table reminder:** existing Facebook channels in the database were OAuthed with the old scope set. Existing users must re-authenticate via the `intent=ads` flow (Settings → Ad Accounts → Connect) to grant the new ads-related scopes. Without this, their `accessToken` will throw "permissions" errors when the wizard tries to create campaigns.

**Privacy policy hosting:** Per project decision (2026-05-29), the privacy policy is hosted on the public-facing marketing website rather than as an in-app route. The wizard requires the user to supply a privacy policy URL for each Lead Form — they should point to their own privacy policy, not Schedura's marketing-site one (the latter is for Schedura, not for advertisers).
