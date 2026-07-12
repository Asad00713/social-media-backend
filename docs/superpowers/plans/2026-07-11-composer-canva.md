# Composer Canva Integration (secure, server-side channel)

> **Status:** In progress (autonomous build; user chose "browse & import designs"
> + "server-side channel — tokens never in browser"). Branch:
> `feat/composer-cloud-sources` (both repos). No commit/push without user.

**Goal:** Let users pick media from their **Canva designs** inside the composer's
Add-media dialog — connect Canva, browse their designs, select one, and have the
backend export it, import it into our storage, and add it to the draft.

**Why a new approach:** The existing `src/canva` backend works but is
**browser-token** based (OAuth callback returns `accessToken`/`refreshToken` in
the redirect URL; every design/export route takes `accessToken` in the body).
The user requires the **cloud-storage security model**: tokens live server-side,
never reach the browser, browse/import happen by a persisted connection. Canva
is **not** in the `socialMediaChannels` platform enum and its OAuth is **not** in
the generic channels OAuth engine, so instead of an enum migration we use a
**dedicated `canva_connections` table** (workspace-scoped, one connection per
workspace) + thin seams that reuse the existing `CanvaService` + `CloudinaryService`.

## Global constraints

- Canva tokens **never reach the browser** — stored in `canva_connections`,
  injected server-side; browse/import by workspace (the connection is looked up
  from the JWT's workspace).
- Canva export URLs are **temporary** → import ALWAYS downloads the export and
  re-uploads to our storage (Cloudinary/R2); never hotlink an export URL.
- Reuse `CanvaService` (OAuth/list/export/refresh) and `CloudinaryService`
  (`uploadFromBuffer`) — do not re-author them.
- One Canva connection per workspace (reconnect upserts). Accepted v1 limitation
  (mirrors Google Photos' per-workspace model).
- shadcn/ui only; theme tokens; icons lucide + `public/canva.png` brand logo.

## Backend (socialmedia-workspace)

### 1. Schema — `canva_connections` table
New file `src/drizzle/schema/canva.schema.ts` (or append to channels.schema.ts):
```
canvaConnections = pgTable('canva_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }).unique(),
  userId: uuid('user_id').notNull().references(() => users.id),
  canvaUserId: varchar('canva_user_id', { length: 255 }),
  displayName: varchar('display_name', { length: 255 }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```
`workspaceId` unique → one connection per workspace (upsert on reconnect).
Generate migration with `npm run db:generate` (creates SQL; user runs
`npm run db:migrate` — do NOT auto-apply to their DB).

### 2. `CanvaConnectionService` (new, `src/canva/canva-connection.service.ts`)
- `upsert(workspaceId, userId, { canvaUserId, displayName, accessToken, refreshToken, expiresIn })` → row (onConflict workspaceId → update tokens+expiry+updatedAt).
- `getByWorkspace(workspaceId)` → row | null.
- `getValidAccessToken(workspaceId)`: load row (404 if none); if `tokenExpiresAt` within a 60s skew → `canvaService.refreshAccessToken(refreshToken)`, persist new tokens+expiry, return fresh token; else return stored token.
- `disconnect(workspaceId)` (optional v1).
Tokens are the only sensitive data; never returned to controllers beyond the token string used server-side.

### 3. Secure connect — modify `CanvaController.oauthCallback`
Currently redirects to `/canva/connect/success?accessToken=...&refreshToken=...`.
**Change:** after `exchangeCodeForTokens` + `getCurrentUser`, call
`canvaConnectionService.upsert(stateData.workspaceId, stateData.userId, {...tokens, canvaUserId: user.userId, displayName: user.displayName})`, then redirect to
`${frontendUrl}/canva/connect/success` **with NO token params** (optionally
`?status=success`). ⚠️ This changes the callback contract — the old Next.js
frontend (if it read tokens from the URL) would need updating; we're unifying on
the Vite app. Document this.

### 4. Composer seams — new `CanvaComposerController` (`src/canva/canva-composer.controller.ts`), `JwtAuthGuard`, workspace from `@CurrentUser`
- `GET /canva/composer/status` → `{ connected: boolean, displayName?: string }` (from getByWorkspace).
- `POST /canva/composer/designs` body `{ limit?, continuation? }` →
  `getValidAccessToken(wsId)` → `canvaService.listDesigns(token, limit, continuation)` →
  `{ items: [{ id, title, thumbnailUrl, width?, height?, updatedAt? }], continuation? }`
  (map CanvaDesign.thumbnail.url → thumbnailUrl; skip designs with no thumbnail).
- `POST /canva/composer/import` body `{ designId }` →
  `getValidAccessToken(wsId)` → `canvaService.exportDesign(token, designId, { format: 'png', quality: 'high' })` →
  `canvaService.waitForExport(token, designId, job.id)` → take `urls[0]` →
  `fetch(url)` → Buffer → `cloudinary.uploadFromBuffer(buf, { folder: 'composer/canva', resourceType: 'image' })` →
  `{ url: up.secureUrl, type: 'image', width: up.width, height: up.height, sizeBytes: up.bytes }`.
  (PNG export → always image. Multi-page designs: import page 1 for v1; note as limitation.)
- Workspace ownership: the connection is keyed by the JWT's workspace, so no
  cross-workspace access is possible.

### 5. Module wiring (`CanvaModule`)
Add `CanvaConnectionService` + `CanvaComposerController`; import the module that
provides `CloudinaryService` (MediaModule) and Drizzle db. Export
`CanvaConnectionService` if needed. Register the new schema in the drizzle schema barrel.

### 6. Tests
- `CanvaConnectionService.getValidAccessToken`: fresh token returned when not
  expired; refresh path invoked + persisted when expired (mock canvaService).
- Composer controller: designs maps CanvaDesign→envelope; import pipeline
  (mock export+wait+fetch+cloudinary) returns permanent-URL shape; status reflects
  connection presence.

## Frontend (socialmedia-frontend)

### API + hooks (`src/features/composer/`)
- `api/canva.api.ts`: `getStatus()`, `listDesigns({limit,continuation})`, `import({designId})`, `initiateOAuth(workspaceId)` (POST `/canva/oauth/initiate` → `{authorizationUrl}`). Types: `CanvaDesignItem { id, title, thumbnailUrl, width?, height?, updatedAt? }`.
- `hooks/use-canva-status.ts` (query), `use-canva-designs.ts` (infinite via continuation), `use-canva-import.ts` (mutation → DraftMediaItem), `use-canva-connect.ts` (popup + initiate + on success invalidate status) — mirror the cloud hooks.

### Components (`components/media-picker/`)
- `canva-pane.tsx`: connected? `CanvaDesignsBrowser` : `CanvaConnectCard`.
- `canva-connect-card.tsx`: Canva logo + name + "Connect Canva" (reuse `openOAuthPopup`).
- `canva-designs-browser.tsx`: grid of design thumbnails (title + thumb), infinite scroll (continuation), click → import (per-tile spinner) → `onAdd(DraftMediaItem)` + close.
- Add Canva to `source-rail.tsx` — a "Design" group (or alongside Cloud). Widen `SourceId` with `'canva'`.
- `media-picker-dialog.tsx`: render `CanvaPane` when `active === 'canva'`.

### Connect landing — `/canva/connect/success` route (`src/pages/canva/connect-success.tsx`)
postMessage to opener (`{ type: OAUTH_RESULT_MESSAGE_TYPE, kind: 'success', platform: 'canva' }`) + close popup (no tokens in URL now). Reuse the channels connect-success pattern. Router: add the route.

### Integrations page
Flip the Canva card to real connect (`comingSoon: false` + connect via the same popup). Canva isn't in `socialMediaChannels`, so it never leaks into the publishing selector (no `isComposablePlatform` change needed).

## Manual steps for the user
- `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` already in `.env` ✅.
- Canva Developer portal: ensure the redirect URI `${APP_URL}/canva/oauth/callback`
  is registered and scopes `design:content:read design:meta:read asset:read profile:read` are enabled.
- Run `npm run db:migrate` to create the `canva_connections` table.

## Known limitations (v1)
- One Canva connection per workspace (reconnect replaces).
- Multi-page designs import page 1 only.
- Callback contract changed (no tokens in redirect URL) — old Next.js frontend
  Canva flow, if any, must adopt the server-side model.
