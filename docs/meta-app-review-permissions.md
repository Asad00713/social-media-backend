# Meta App Review — Permissions Inventory (app-wise)

Source of truth for what the **code actually requests** vs what is queued in
**Meta App Console → App Review → "Not submitted" / New requests**.

Legend:
- **Code?** — is the permission in `PLATFORM_CONFIG.<platform>.oauthScopes`
  (`src/drizzle/schema/channels.schema.ts`)?
- **AR** = needs App Review (Advanced Access) to work for non-role users
- **BV** = also needs **Business Verification** (app-level, do this once)
- Default = granted without review; works in production

> **Rule:** never submit a permission the code doesn't request. Every permission
> needs its own use-case + screencast, and the reviewer must be able to
> reproduce it. Un-demonstrable permissions get rejected and can bounce the
> whole use case.

---

## ⚠️ Two warnings before you touch the console

### 1. The trash icon is SAFE
The trash icon in **App Review → New requests** removes the item from the
**submission only** — not from your app. Threads / FB / IG will keep working in
development because app admins, developers and testers always get **Standard
Access** to every permission the app has.

Only **"customize use cases"** removes a permission from the app itself. Do
**not** use that to clean up the submission, or the OAuth consent screen will
stop granting those scopes and connected channels will break.

### 2. 🚨 WhatsApp is NOT demo-able as currently built (submission blocker)
`POST /workspaces/:workspaceId/whatsapp/connect` is a **manual token connect**
(`channels.controller.ts:5362`). The user pastes their own `phoneNumberId`,
`wabaId` and `accessToken` (`dto/connect-whatsapp.dto.ts`). There is **no
Facebook Login / Embedded Signup consent screen** that grants
`whatsapp_business_messaging` to *our* app.

App Review for the `whatsapp_*` permissions requires a screencast showing **our
app's Facebook Login consent dialog** requesting those scopes. With the manual
flow there is nothing to show → **rejection**.

Two valid paths:

| Path | What it means | App Review needed? |
|---|---|---|
| **A. Keep manual token paste** | Each customer creates their own Meta app + WABA + permanent token and pastes it. Token belongs to *their* app, not ours. | ❌ **No `whatsapp_*` App Review needed at all.** Bad UX, doesn't scale. |
| **B. Embedded Signup (Tech Provider)** | Business grants *our* app access to *their* WABA via Facebook Login. The real multi-tenant SaaS model. | ✅ `whatsapp_business_messaging` + `whatsapp_business_management` + **Business Verification** + **Tech Provider** verification |

**Decide A vs B before submitting.** If B → implement Embedded Signup first,
then record the screencast. Business Verification (2–5 days) can start now
regardless; it gates every BV row below.

---

## WhatsApp — 3 in console, 2 used

| Permission | Code? | Needs | Action |
|---|---|---|---|
| `whatsapp_business_messaging` | ✅ | AR + **BV** | **Keep** (blocked on Embedded Signup — see above) |
| `whatsapp_business_management` | ✅ | AR + **BV** | **Keep** (same) |
| `whatsapp_business_manage_events` | ❌ | AR | **Remove** — unused |

> "Human Agent" is **not** a WhatsApp permission — it's a Messenger / Instagram
> messaging feature (extends the reply window to 7 days for human agents).
> WhatsApp Cloud API has no `human_agent`.

---

## Facebook / Pages — 16 in console, 12 used

| Permission | Code? | Needs | Action |
|---|---|---|---|
| `public_profile` | ✅ | Default | Keep |
| `email` | ❌ | Default | Keep (harmless, no review burden) |
| `pages_show_list` | ✅ | AR | Keep |
| `pages_read_engagement` | ✅ | AR | Keep |
| `pages_manage_posts` | ✅ | AR | Keep |
| `pages_manage_metadata` | ✅ | AR | Keep |
| `pages_manage_engagement` | ✅ | AR | Keep — first-comment feature |
| `pages_read_user_content` | ✅ | AR | Keep — inbox comments |
| `pages_manage_ads` | ✅ | AR | Keep — Boost |
| `ads_management` | ✅ | AR + **BV** | Keep — Boost |
| `ads_read` | ✅ | AR + **BV** | Keep — Boost |
| `leads_retrieval` | ✅ | AR + **BV** | Keep — Lead Ads |
| `business_management` | ✅ | AR + **BV** | Keep — Boost / ad accounts |
| `pages_messaging` | ❌ | AR | **Remove** — FB DM inbox is Phase 2 |
| `read_insights` | ❌ | AR | **Remove** — unless you demo FB Page insights (then add to code first) |
| `catalog_management` | ❌ | AR | **Remove** — no catalog/commerce feature |

---

## Instagram — 8 in console, but two different API generations 🚨

The code uses the **new** *Instagram API with Instagram Login* (`instagram_business_*`).
The console also has the **legacy** *Instagram API with Facebook Login*
(`instagram_*`). Submit **one generation only** — mixing both confuses reviewers.

### Keep — new (Instagram Business Login)
| Permission | Code? | Needs | Action |
|---|---|---|---|
| `instagram_business_basic` | ✅ | AR | Keep |
| `instagram_business_manage_messages` | ✅ | AR | Keep |
| `instagram_business_manage_comments` | ✅ | AR | Keep |
| `instagram_business_content_publish` | ✅ | AR | Keep |
| `instagram_business_manage_insights` | ⚠️ mismatch | AR | Keep — **fix code** (see below) |

### Remove — legacy (Instagram Graph API via Facebook Login)
| Permission | Action |
|---|---|
| `instagram_basic` | **Remove** — legacy dup of `instagram_business_basic` |
| `instagram_manage_comments` | **Remove** — legacy dup |
| `instagram_manage_messages` | **Remove** — legacy dup |

### 🔧 Code fix required
`channels.schema.ts` requests the **legacy** `instagram_manage_insights` while
every other IG scope is the new `instagram_business_*` generation:

```
instagram_manage_insights  →  instagram_business_manage_insights
```

Changing this is a scope change — **existing Instagram channels must reconnect**
(tokens never gain scopes retroactively).

---

## Threads — 7 in console, 6 used

| Permission | Code? | Needs | Action |
|---|---|---|---|
| `threads_basic` | ✅ | AR | Keep |
| `threads_content_publish` | ✅ | AR | Keep |
| `threads_read_replies` | ✅ | AR | Keep |
| `threads_manage_replies` | ✅ | AR | Keep — hide/unhide |
| `threads_manage_insights` | ✅ | AR | Keep — insights |
| `threads_manage_mentions` | ✅ | AR | Keep — mentions tab |
| `threads_delete` | ❌ | AR | **Remove** — no delete feature |

---

## Features (not permissions)

| Feature | What it's for | Action |
|---|---|---|
| **Human Agent** | Messenger / IG messaging — 7-day human-agent reply window | Keep only if FB/IG DM human handoff ships. **Not WhatsApp.** |
| **Marketing API Access Tier** | Higher ads API volume (Boost) | Keep — needs **BV** |
| **Business Asset User Profile Access** | Read business-asset user profiles in ads flows | Verify need; remove if unused |

---

## Recommended submission batches

Don't submit everything at once — one bad item can bounce a whole use case.

1. **Batch 1 — Threads (6)** — built, live-tested, screencasts in progress. Fastest win.
2. **Batch 2 — FB/IG Pages** — `pages_*` + `instagram_business_*` (posting + inbox).
3. **Batch 3 — Ads / Leads** — `ads_management`, `ads_read`, `leads_retrieval`, `business_management`, `pages_manage_ads`. Needs **Business Verification**.
4. **Batch 4 — WhatsApp** — only after deciding path A vs B above. If B, ship Embedded Signup first.

**Start Business Verification now** — it's app-level, takes 2–5 days, and gates
every BV row.

---

## Per-permission App Review checklist

For each submitted permission Meta wants:
- A clear **use-case description** (what data, why, how it benefits the user)
- A **screencast**: log in → **consent screen showing that exact permission** →
  the feature using the data. 1080p, English, no audio needed.
- **Step-by-step repro instructions** the reviewer can follow
- **Test credentials** (a working account in the app)

App-level prerequisites: Privacy Policy URL, Data Deletion instructions/callback,
app icon + category, valid OAuth redirect URIs, app in **Live** mode.
