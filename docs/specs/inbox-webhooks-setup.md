# Inbox Webhooks — Meta App Console Setup

This doc is the operator runbook for enabling realtime webhook delivery on the 3 Meta-family platforms supported by Phase 1 inbox: **Facebook**, **Instagram**, **Threads**.

The other 3 supported platforms (YouTube, Bluesky, Mastodon) don't use webhooks — they're polled every 5 minutes by the `INBOX_POLLING` BullMQ worker, no configuration needed.

---

## 0. Prerequisites

- The Schedura backend must be reachable over **HTTPS** at a stable public URL. In dev that means `ngrok http 3000`; in prod the production domain.
- You'll need the **App Dashboard** access for the existing Meta App used for Schedura publishing — i.e. the same app whose `clientId` is in `platform_credentials` for `facebook`, `instagram`, and `threads`.
- Set the env var `META_WEBHOOK_VERIFY_TOKEN` to a strong random string. The same value goes in both the env and the Meta dashboard during subscription. Default (used in dev): `webondev_verify_123` — **do not ship this to prod**.

---

## 1. Webhook URLs

Backend already exposes these endpoints (registered in `InboxModule` → `WebhooksController`). Replace `https://api.schedura.app` with your actual public hostname:

| Platform   | Webhook URL                                  | Verify Token                          |
|------------|----------------------------------------------|---------------------------------------|
| Facebook   | `https://api.schedura.app/webhooks/facebook` | `$META_WEBHOOK_VERIFY_TOKEN`          |
| Instagram  | `https://api.schedura.app/webhooks/instagram`| `$META_WEBHOOK_VERIFY_TOKEN`          |
| Threads    | `https://api.schedura.app/webhooks/threads`  | `$META_WEBHOOK_VERIFY_TOKEN`          |

Each URL serves both:
- `GET` — Meta's `hub.verify_token` challenge (one-time, during subscription setup)
- `POST` — event delivery (every comment/reply event)

---

## 2. Facebook — subscribe Page webhook to `feed`

1. Open the Meta App Dashboard → your app → **Products → Webhooks**.
2. Click **Page** in the products dropdown.
3. **Callback URL**: `https://api.schedura.app/webhooks/facebook`
   **Verify Token**: the value of `META_WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and Save**. Meta hits the GET endpoint with the challenge — backend logs `Facebook webhook verified successfully`.
5. Under **Subscription fields** for Page, toggle ON:
   - `feed` — fires for posts, comments, and reactions on the Page.
6. For each connected FB Page channel, also call the Page-level subscription endpoint **once** so the app receives events for that specific Page. This is the per-Page step that Meta requires in addition to the app-level webhook:
   ```
   POST https://graph.facebook.com/v18.0/{page-id}/subscribed_apps
     ?subscribed_fields=feed
     &access_token={page-access-token}
   ```
   (Schedura's onboarding flow can automate this — TODO: add to the FB connect handler if not already done.)

**Required scopes (already added to `PLATFORM_CONFIG.facebook.oauthScopes`):**
- `pages_read_user_content` — read user comments on the Page
- `pages_manage_engagement` — write replies (already there from first-comment work)

---

## 3. Instagram — subscribe `comments` field

1. Same Webhooks page → **Instagram** in the products dropdown.
2. **Callback URL**: `https://api.schedura.app/webhooks/instagram`, same verify token.
3. **Verify and Save** → backend logs `Instagram webhook verified successfully`.
4. Under **Subscription fields** for Instagram, toggle ON:
   - `comments` — fires when someone comments on your IG Business / Creator media.
5. Each connected IG Business account needs an **app-level subscription** too. This is automatic if the user logged in via Instagram Business Login with the right scopes — but if not, call:
   ```
   POST https://graph.instagram.com/{ig-user-id}/subscribed_apps
     ?subscribed_fields=comments
     &access_token={ig-user-access-token}
   ```

**Required scope (already added):** `instagram_business_manage_comments`.

---

## 4. Threads — subscribe `replies` field

1. Same Webhooks page → **Threads** in the products dropdown.
2. **Callback URL**: `https://api.schedura.app/webhooks/threads`, same verify token.
3. **Subscription fields** → toggle ON: `replies`.

**Required scopes (already added):**
- `threads_read_replies` — receive reply events
- `threads_manage_replies` — post replies back (already there from threading)

### ⚠️ Threads-only dev-mode behavior

Threads webhooks **DO NOT fire in app development mode**, even for app admins / developers / testers. This is stricter than FB/IG which DO deliver to app-role accounts in dev. The Meta dashboard shows this warning explicitly on the Threads webhook page.

**Mitigation already in code:** `InboxPollScheduler.POLLED_PLATFORMS` includes `threads`, so the 5-min polling worker fetches Threads replies via the conversation API as a fallback. Once the app is published and the webhook starts firing in prod, the unique constraint on `inbox_items.(channelId, platformItemId)` drops the inevitable duplicates between webhook and poll.

If you want webhook-only behavior in prod (to save quota), you can remove `'threads'` from `POLLED_PLATFORMS` after launch — but the redundancy is cheap and protects against webhook delivery failures.

---

## 5. App Review (production only)

The webhook subscriptions above work immediately in **development mode** for users with a **Tester/Developer/Admin** role on the Meta App. For end users, the app must pass **App Review** for each scope:

| Scope                                | Use case to request                                    |
|--------------------------------------|--------------------------------------------------------|
| `pages_read_user_content`            | "Read user-generated comments to power our unified inbox" |
| `pages_manage_engagement`            | "Reply to user comments from our inbox UI"             |
| `instagram_business_manage_comments` | "Manage comments on IG Business posts via our inbox"   |
| `threads_read_replies`               | "Read replies to power our unified inbox"              |
| `threads_manage_replies`             | "Reply to user replies from our inbox UI"              |

Each scope requires:
- A **demo video** (~2 min) showing the flow that uses it inside Schedura.
- A **test account** Meta reviewers can log into.
- A **privacy policy URL** that mentions inbox + reply features.

Budget: app review usually takes 5–10 business days per submission. Submit at least **8 weeks** before launch.

---

## 6. Verifying it works

After completing the Meta dashboard steps:

1. Run the backend somewhere reachable (`ngrok http 3000` in dev).
2. Connect a FB Page / IG Business / Threads account in Schedura.
3. Publish a post via Schedura to that account.
4. From another account, comment on the post.
5. Within ~5 seconds, check backend logs:
   ```
   [WebhooksController] instagram webhook — account=... field=comments
   ```
6. Check the inbox UI — the comment should appear without a manual refresh (the `inbox.item.created` realtime event pushes it).

If the webhook fires but the UI doesn't update:
- Check that the WebSocket connection is alive (`Network` tab → `/realtime` WS frame).
- Check that the comment is on a post Schedura published (Phase 1 only ingests for matched `posts.platformPostId`).

If the webhook never fires:
- Re-verify the Meta dashboard subscription is active (not just saved).
- Confirm the per-Page / per-account `subscribed_apps` call was made.
- Hit the GET endpoint directly: `curl 'https://api.schedura.app/webhooks/facebook?hub.mode=subscribe&hub.verify_token=$TOKEN&hub.challenge=test'` should return `test`.

---

## 7. Signature verification (Phase 1 deferred)

Meta signs webhook POST bodies with `X-Hub-Signature-256` using your **App Secret** as the HMAC key. **Phase 1 does not verify this** — we rely on the `verify_token` and IP allowlist instead.

Before production:
- Add HMAC-SHA256 verification middleware on the POST endpoints.
- Reject any request whose signature doesn't match.
- This is critical for prod because a malicious actor who knows the URL could spam fake comments into your inbox otherwise.

Tracking ticket: `INBOX-PROD-2` — add HMAC verification before public launch.
