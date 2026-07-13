# Calendar Integrations (Google Calendar frontend + Outlook Calendar full-stack) Implementation Plan

> **For agentic workers:** Executed via subagent-driven-development. Steps use checkbox syntax.

**Goal:** Ship a professional "connect your calendar" experience that lets a workspace connect **Google Calendar** and **Microsoft Outlook Calendar** so scheduled posts sync to the user's external calendar. Google Calendar backend already exists; this adds Outlook Calendar backend (parity with Google) and the entire frontend connect experience for both.

**Architecture:** Calendar providers are `accountType: 'storage'` OAuth channels (like cloud storage), keyed by a `platform` string on the existing `social_media_channels` table. Connect reuses the generic `/channels/workspaces/:wsId/oauth/initiate` endpoint + existing channel OAuth callback + `/channels/connect/success` popup page — no new connect endpoint or success route. Outlook mirrors the existing `GoogleCalendarService` but against Microsoft Graph (`/me/calendars`, `/me/events`), reusing OneDrive's Azure AD v2.0 OAuth base. Frontend adds a dedicated professional "Calendar sync" page + wires the two existing integrations-catalog cards to real connect.

**Tech Stack:** NestJS + Drizzle (Postgres, `platform` is `varchar(20)` — **no DB migration needed**), Microsoft Graph REST, Vite + React 19 + shadcn/ui + TanStack Query.

## Global Constraints

- **No DB migration.** `platform` is `varchar('platform', { length: 20 })`. `outlook_calendar` = 16 chars, fits. Do NOT run `db:generate`/`db:push` (backend tree carries unrelated drift).
- **Reuse, never re-author.** Mirror `GoogleCalendarService`/its controller/oauth config; reuse `useCloudConnect`/`openOAuthPopup`/integrations-grid patterns. Do not invent new OAuth plumbing.
- **shadcn-only frontend.** Every UI surface composes existing `src/components/ui/*` primitives (button, card, badge, switch, alert, separator, skeleton, tooltip) + Tailwind layout + lucide icons + the existing brand logos (`/googlecalendar.png`, `/outlookcalendar.png`). No hand-rolled chrome, no new UI libs. Theme tokens only (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`).
- **Tokens are server-side only.** Calendar OAuth tokens never reach the browser (generic channel callback stores them). Frontend only ever sees `{ authorizationUrl }` and connected-status booleans.
- **Settings page width convention:** `mx-auto ... w-full max-w-5xl ... md:pt-6 md:pb-24 md:px-6 lg:px-8` (match `src/pages/settings/integrations.tsx`).
- **Surgical git staging.** Backend tree has ~46 unrelated dirty files from other efforts and an uncommitted foreign hunk in `channels.schema.ts`. NEVER `git add -A`/`git add .`. Stage ONLY the exact calendar files. For `channels.schema.ts`, stage only the calendar hunk (partial patch). Never stage `.env`.

---

## Task 1 — Backend: Outlook Calendar provider parity with Google Calendar

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts` — add `'outlook_calendar'` to the platforms array (after `google_calendar`, ~line 33) and an `outlook_calendar` block to `PLATFORM_CONFIG` (mirror the `google_calendar` block at ~line 606, but storage/Microsoft).
- Modify: `src/channels/services/oauth.service.ts` — add `outlook_calendar` to the OAuth `PROVIDER_CONFIG` (reuse OneDrive's Azure AD base at ~line 180) and to any calendar/storage special-casing (mirror the `google_calendar` special-case at ~line 760 if the flow branches for calendar redirect handling).
- Create: `src/channels/services/outlook-calendar.service.ts` — mirror `src/channels/services/google-calendar.service.ts` (all public methods) against Microsoft Graph.
- Modify: `src/channels/channels.controller.ts` — add `outlook-calendar/*` endpoints mirroring the `google-calendar/*` endpoints (inject `OutlookCalendarService`).
- Modify: `src/channels/channels.module.ts` — register + export `OutlookCalendarService`.
- Modify: `src/queue/rate-limiter.service.ts` — add an `outlook_calendar` rate-limit bucket (mirror `google_calendar` at ~line 79).
- Modify: `src/chatbot/services/context-builder.service.ts` — add `outlook_calendar` to the known-channel list (mirror `google_calendar` at ~line 15).
- Test: `src/channels/services/outlook-calendar.service.spec.ts` — if `google-calendar.service.spec.ts` exists, mirror its shape; otherwise unit-test the Graph event mapping (Schedura post → Graph event body) and error handling with a mocked fetch.

**Config values (exact):**

`PLATFORM_CONFIG.outlook_calendar`:
```ts
outlook_calendar: {
  name: 'Outlook Calendar',
  accountTypes: ['storage'], // Utility service, not a posting platform
  supportsRefreshToken: true,
  tokenExpirationDays: null,
  refreshTokenTtlDays: 60, // Microsoft consumer refresh tokens expire after ~90d inactivity; warn at 60
  maxMediaPerPost: 0,
  maxTextLength: 0,
  supportedMediaTypes: [],
  oauthScopes: [
    'Calendars.ReadWrite', // Create/update/delete events on the user's calendars
    'offline_access',      // Refresh token
    'User.Read',           // /me
  ],
},
```

OAuth `PROVIDER_CONFIG.outlook_calendar` (reuse OneDrive's Azure AD v2.0 `/common` endpoint):
```ts
outlook_calendar: {
  authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: PLATFORM_CONFIG.outlook_calendar.oauthScopes,
  usePKCE: true,
  additionalParams: { response_type: 'code' },
},
```

**Microsoft Graph mapping notes (Graph differs from Google Calendar):**
- Base: `https://graph.microsoft.com/v1.0`.
- List calendars: `GET /me/calendars` (value[]: `{ id, name, isDefaultCalendar }`). Primary: `GET /me/calendar`.
- Create event: `POST /me/events` (or `/me/calendars/{id}/events`) with body:
  `{ subject, body: { contentType: 'HTML', content }, start: { dateTime, timeZone: 'UTC' }, end: { dateTime, timeZone: 'UTC' } }`.
  Graph `dateTime` is ISO-8601 **without** the trailing `Z` (timezone carried in `timeZone`). Use `'UTC'` and strip the `Z`, or send UTC ISO and `timeZone: 'UTC'`.
- Update: `PATCH /me/events/{id}`. Delete: `DELETE /me/events/{id}`. Get: `GET /me/events/{id}`. List: `GET /me/events` (or `/me/calendarView?startDateTime=&endDateTime=`).
- Auth header: `Authorization: Bearer <accessToken>` (same as OneDrive service).
- Map the same higher-level helpers Google has: `createPostEvent`, `updatePostEvent`, `markEventAsPublished`, `markEventAsFailed`, `verifyAccess`, keeping the SAME method signatures and return shapes as `GoogleCalendarService` so the controller layer is symmetric.

**Steps:**
- [ ] Read `google-calendar.service.ts` + its controller endpoints + `channels.module.ts` registration end-to-end (this is the contract to mirror).
- [ ] Add `outlook_calendar` to platforms array + `PLATFORM_CONFIG` (values above).
- [ ] Add `outlook_calendar` OAuth `PROVIDER_CONFIG` (values above); mirror any `google_calendar` calendar special-casing.
- [ ] Write `outlook-calendar.service.ts` mirroring every public method of `GoogleCalendarService`, translated to Microsoft Graph (mapping notes above). Reuse OneDrive's token/refresh + fetch conventions.
- [ ] Add `outlook-calendar/*` controller endpoints mirroring `google-calendar/*` (same routes/shapes, `outlook-calendar` prefix).
- [ ] Register `OutlookCalendarService` in `channels.module.ts`; add rate-limiter bucket + chatbot context entry.
- [ ] Write `outlook-calendar.service.spec.ts` (mirror Google's spec if present, else test Graph mapping + error paths with mocked fetch).
- [ ] `npm run build` (backend) — must compile. Run the new spec — must pass.
- [ ] Commit ONLY the calendar files (surgical staging; `channels.schema.ts` calendar hunk only).

---

## Task 2 — Frontend: calendar connect plumbing (both providers) + wire integrations cards

**Files:**
- Create: `src/features/calendar/api/calendar-connect.api.ts` — `calendarConnectApi.initiateOAuth(workspaceId, provider)` → `{ authorizationUrl }`, posting to the generic `/channels/workspaces/${workspaceId}/oauth/initiate` with `{ platform: provider }` (mirror `cloud-media.api.ts` `initiateOAuth`). Export `type CalendarProvider = 'google_calendar' | 'outlook_calendar'`.
- Create: `src/features/calendar/hooks/use-calendar-connect.ts` — `useCalendarConnect(workspaceId)` returning `{ connect(provider), pendingProvider }`, modeled on `use-cloud-connect.ts` (synchronous `openOAuthPopup()` → async initiate → `.navigate(url)`; listen `OAUTH_RESULT_MESSAGE_TYPE`, guard `event.origin`, filter `payload.platform === provider`, invalidate `queryKeys.channels.list(workspaceId)` on success + toast, close popup opener-side).
- Create: `src/features/calendar/hooks/use-calendar-connections.ts` — `useCalendarConnections(workspaceId)` deriving per-provider connected status from the channels list query (`queryKeys.channels.list`), returning `{ isConnected(provider): boolean, connectionOf(provider), isLoading }`. Reuse whatever channels-list hook `integrations-grid`/cloud already use (do NOT add a new endpoint).
- Modify: `src/features/integrations/constants/integrations-catalog.ts` — add `calendarProvider?: CalendarProvider` to `IntegrationApp`; set it on the `google-calendar` and `outlook-calendar` entries; flip both `comingSoon: false`.
- Modify: `src/features/integrations/components/integrations-grid.tsx` — extend `showConnectUi`, `isConnected`, `isConnecting`, `handleConnect` with a calendar branch (`app.calendarProvider` → `useCalendarConnect().connect(provider)` + `useCalendarConnections().isConnected(provider)`).

**Steps:**
- [ ] Read `use-cloud-connect.ts`, `cloud-media.api.ts`, `integrations-grid.tsx`, `oauth-popup.ts` (contracts to mirror).
- [ ] Add `calendar-connect.api.ts` (Canva/cloud initiate shape → generic channel endpoint).
- [ ] Add `use-calendar-connect.ts` (mirror cloud connect; provider-filtered).
- [ ] Add `use-calendar-connections.ts` (derive status from channels list; no new endpoint).
- [ ] Extend `IntegrationApp` + the two catalog entries (`calendarProvider`, `comingSoon:false`).
- [ ] Extend `integrations-grid.tsx` connect logic with the calendar branch.
- [ ] `npm run build` (frontend) — must compile. Manually reason through: clicking a calendar card opens the OAuth popup and flips to Connected on success.
- [ ] Commit ONLY these files.

---

## Task 3 — Frontend: professional "Calendar sync" page + route + settings nav

**Files:**
- Create: `src/features/calendar/components/calendar-sync-page.tsx` — the professional connect page. Thin page shell composes sub-components below.
- Create: `src/features/calendar/components/calendar-sync-hero.tsx` — hero: headline ("Your schedule, everywhere" / concise professional copy — original, NOT ClickUp's), subcopy explaining scheduled posts sync to your calendar, and the two provider connect buttons (logo + name), each showing connect spinner / a "Connected" state with a disconnect affordance.
- Create: `src/features/calendar/components/calendar-sync-features.tsx` — 3 feature highlights (card grid): e.g. "See posts in your calendar", "Never double-book", "Works with your team's tools" — each icon (lucide) + title + one line. Original copy.
- Create: `src/pages/settings/calendars.tsx` — 5-line shim rendering `<CalendarSyncPage />` inside the settings layout wrapper (`max-w-5xl ... md:px-6 lg:px-8`).
- Modify: `src/router.tsx` — add route `settings/calendars` → `SettingsCalendarsPage`, inside the `/w/:workspaceId` guarded group (sibling of `settings/integrations`, ~line 205). Lazy-load to match siblings.
- Modify: `src/features/dashboard/constants/settings-nav.ts` — add a `{ label: 'Calendar', to: '.../settings/calendars', icon, description }` entry to `WORKSPACE_SETTINGS_NAV` (choose a fitting Iconly icon already imported there; `comingSoon: false`).

**Design requirements (professional, ClickUp-*inspired* not copied):**
- Theme-aware (light/dark) via tokens only. Responsive; verify 375px — buttons stack, no edge-touch (`px` per convention).
- Connect buttons: large, `Button variant="outline"` with the brand logo (`GoogleCalendarLogo`/`OutlookCalendarLogo` from `integration-logos.tsx`) + name; spinner (`Loader2`) while connecting; on connected show a `Badge`/check + "Disconnect" (disconnect = delete the channel via existing channels delete mutation if present; otherwise a follow-up — do NOT invent a backend endpoint, reuse channel removal).
- Empty/connected/loading/error states all handled (skeleton while `useCalendarConnections` loads).
- Reuse `useCalendarConnect` + `useCalendarConnections` from Task 2 (single source of truth; page + integrations cards stay consistent).
- Page shell stays thin (no god-file); logic lives in the hooks; sub-components each < ~120 lines.

**Steps:**
- [ ] Build `calendar-sync-hero.tsx` (connect buttons wired to `useCalendarConnect`; status from `useCalendarConnections`; disconnect via existing channel-delete mutation, or omit disconnect with a TODO if no reuse exists — flag in report).
- [ ] Build `calendar-sync-features.tsx` (3 shadcn `Card` highlights, original copy, lucide icons).
- [ ] Build `calendar-sync-page.tsx` (compose hero + features + a "what gets synced" note).
- [ ] Add `src/pages/settings/calendars.tsx` shim + wrapper.
- [ ] Add route in `router.tsx` + nav entry in `settings-nav.ts`.
- [ ] `npm run build` (frontend) — must compile. Reason through all states at 375px + desktop, light + dark.
- [ ] Commit ONLY these files.

---

## Self-review checklist (run before final review)
- Backend compiles; Outlook service method signatures match Google's; no DB migration generated.
- Frontend compiles; no new UI primitive hand-rolled; theme tokens only; 375px safe.
- Both providers connect via the generic channel OAuth (no new endpoint/success route).
- Integrations cards and the dedicated page share the same hooks (consistent connected state).
- Only calendar files staged in each commit; `.env` and foreign dirty files untouched.
