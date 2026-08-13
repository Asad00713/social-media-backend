# Campaigns Backend — Persistence & CRUD (Phase 1)

**Date:** 2026-08-09
**Repos:** `socialmedia-workspace` (backend, primary) + `socialmedia-frontend` (frontend swap)
**Status:** Spec — approved, ready for implementation plan

## Goal

Make the Campaigns module actually persist. Today the entire module is
frontend-only, backed by an in-memory mock store (`campaigns-mock-store.ts`);
`campaigns.api.ts` delegates every call to it and is REST-shaped with `// TODO`
swap markers. This phase builds the real NestJS `CampaignsModule` (schema +
CRUD + lifecycle) and swaps the frontend from mock → real API, so campaigns
survive a reload and live in Postgres.

## Scope

**In scope (Phase 1)**
- New backend module `src/campaigns/` (module + controller + service + DTOs).
- Three Drizzle tables: `campaigns`, `campaign_days`, `campaign_slot_content`.
- Full CRUD + lifecycle (create/list/get/update/delete, launch/pause/resume/
  duplicate) matching the mock's exact REST surface and `Campaign` shape.
- Day/slot ("events") CRUD operating on the normalized slot tables.
- Frontend swap: `campaigns.api.ts` mock → real `apiClient` calls; delete the
  mock store.

**Out of scope (later phases — noted, not built)**
- **Phase 2 — real publishing:** launch → scheduled slots → BullMQ jobs →
  existing `PublisherFactory` → real platform posts. In Phase 1
  `launch/pause/resume` only flip `status`.
- **Phase 3 — real AI Autopilot:** runtime LLM generation + approval
  notifications. In Phase 1 the AI-slot endpoints reuse the mock caption
  behavior the frontend mock has today (fill a placeholder, set
  approved/pending_review).

## Background & Constraints (verified)

- The `drips` module (`src/drips/`) is the closest existing analog —
  workspace-scoped `campaign + posts + history`, `draft/active/paused/
  completed/cancelled` statuses, `targetChannelIds` jsonb, schedule config,
  BullMQ job-id columns, activate/pause/cancel actions, per-post review flow.
  The Campaigns backend mirrors its structure and conventions.
- Backend patterns: Service-Controller-Module per feature; DTOs use
  `class-validator` with global `ValidationPipe` (whitelist on); Drizzle
  schema files in `src/drizzle/schema/` exported via `index.ts`; migrations
  via `npm run db:generate` + `npm run db:migrate`. Auth via `JwtAuthGuard` +
  `@CurrentUser()`.
- The frontend was built for this swap: `campaigns.api.ts` already carries
  REST-shaped comments matching each endpoint, and `campaigns-mock-store.ts`
  IS the authoritative behavior contract the backend must reproduce.

## Architecture

New backend module `src/campaigns/`:
- `campaigns.module.ts`, `campaigns.controller.ts`, `campaigns.service.ts`,
  `dto/campaigns.dto.ts` (+ `campaigns.service.spec.ts`).
- Registered in `app.module.ts`.
- Route prefix `campaigns`, all endpoints `@UseGuards(JwtAuthGuard)`, all
  workspace-scoped: `campaigns/workspaces/:workspaceId/...`.

## Data model (3 tables)

`src/drizzle/schema/campaigns.schema.ts` (export from `index.ts`).

### `campaigns`
- `id` uuid pk, `workspaceId` uuid FK→workspace (cascade),
  `createdById` uuid FK→users (set null)
- `name` varchar, `description` text nullable
- `type` varchar (`bulk`/`drip`/`evergreen`)
- `status` varchar (`draft`/`scheduled`/`active`/`paused`/`completed`/`failed`)
- `schedule` jsonb (`CampaignSchedule` union — bulk/drip/evergreen shape)
- `contentSource` varchar (`manual`/`library`/`ai`)
- `aiConfig` jsonb nullable (`AiAutopilotConfig`)
- `libraryTemplateIds` jsonb `string[]` default `[]`
- **`channelIds` jsonb `string[]`** — denormalized CACHE, refreshed on slot
  mutations (union of channels across slots); slot-derivation is the
  correcting source of truth.
- **`platforms` jsonb `SocialPlatform[]`** — same cache treatment.
- `createdAt`, `updatedAt` timestamps.
- **NOT stored (computed on read):** `metrics`, `nextRunAt`.

### `campaign_days`
- `id` uuid pk, `campaignId` uuid FK→campaigns (cascade)
- `date` varchar/date (`yyyy-MM-dd`)
- `skip` boolean default false
- unique index `(campaignId, date)`
- Rationale: `DayContent.skip` is day-level and a day can exist with zero
  channels, so it needs its own row — not denormalized onto slots.

### `campaign_slot_content`
- `id` uuid pk, `campaignId` uuid FK→campaigns (cascade)
- `date` varchar/date (`yyyy-MM-dd`), `channelId` varchar
- `content` jsonb (`ChannelDayContent`: mode / postType / caption / media /
  threadParts / poll / templateIds / aiSubState / **platformSpecific**)
- `createdAt`, `updatedAt`
- unique index `(campaignId, date, channelId)`

**Read assembly:** the API rebuilds the nested `SlotContentMap`
(`{ [date]: { channelContent: { [channelId]: ChannelDayContent }, skip } }`)
from `campaign_days` + `campaign_slot_content` rows, so the frontend
`Campaign` shape is byte-identical to the mock's.

### Computed-on-read fields
- **`metrics`**: `postsPlanned` = count of filled slots (`isChannelDayFilled`
  logic ported to backend) across non-skipped days; `postsPublished/Failed/
  Skipped` = 0 in Phase 1 (nothing publishes). No stored counter → no drift.
- **`nextRunAt`**: display-only. Compute the next future firing (date+time ≥
  now, within schedule start–end, honoring skip/weekend rules) when status is
  `active`/`scheduled`; else `null`. Not a real job trigger until Phase 2's
  scheduler owns it.
- **`channelIds`/`platforms`**: served from the cache columns; a slot mutation
  recomputes and rewrites the cache. `platforms` derivation skips channel ids
  that no longer resolve to a connected channel.

## API / DTO mapping

Every `campaignsApi.*` → one endpoint, same shape; every mutation returns the
full assembled `Campaign`.

| Frontend `campaignsApi.*` | Endpoint |
|---|---|
| `list({status,search})` | `GET /campaigns/workspaces/:ws?status=&search=` |
| `statusCounts()` | `GET /campaigns/workspaces/:ws/status-counts` → 7 keys `all/draft/scheduled/active/paused/completed/failed` |
| `get(id)` | `GET /campaigns/workspaces/:ws/:id` |
| `createSimple(input)` | `POST /campaigns/workspaces/:ws` (Simple/`bulk` only) |
| `update(id,patch)` | `PATCH /campaigns/workspaces/:ws/:id` |
| `remove(id)` | `DELETE /campaigns/workspaces/:ws/:id` |
| `launch/pause/resume/duplicate` | `POST /campaigns/workspaces/:ws/:id/{launch,pause,resume,duplicate}` — status flip only |
| `addDay/removeDay/setDaySkip` | `POST /…/:id/days` · `DELETE /…/:id/days/:date` · `PATCH /…/:id/days/:date` |
| `addEvent/updateEvent/removeEvent` | `POST /…/:id/events` · `PATCH /…/:id/events` · `DELETE /…/:id/events` (body: date, channelId, [postType, platform], [patch]) |
| `generateAiForEvent/approveAiEvent/skipAiEvent` | `POST /…/:id/events/ai/{generate,approve,skip}` — Phase 1 mock caption (mirrors current frontend mock) |

DTOs use `class-validator`. `createSimple` DTO mirrors `CreateSimpleCampaignInput`
(name, description?, startDate, endDate, timezone, defaultTime, skipWeekends).
`update` DTO mirrors `UpdateCampaignPatch` (accepts `channelIds`/`platforms`
for API-shape parity, but slot-derivation remains authoritative and overrides
on the next slot change).

## Frontend swap

- `campaigns.api.ts`: replace each `store.*` with an `apiClient` call to the
  matching endpoint. Method signatures + return types UNCHANGED → hooks and
  components need zero changes.
- **`workspaceId` seam:** real endpoints are workspace-scoped but the current
  api functions are global (mock). Thread `workspaceId` from the hooks (they
  run in components with `useWorkspaceId()`) into the api functions. Exact
  seam finalized in the plan (default: hooks pass `workspaceId`).
- Delete `campaigns-mock-store.ts` and `mock-campaigns.ts` after the swap is
  verified.
- React Query keys/hooks unchanged (`queryClient`, `use-campaigns`, mutation
  hooks all keep working).
- Full-stack type consistency: backend produces the exact `Campaign` interface
  the frontend already declares.

## Error handling

- `NotFoundException` (404) for missing campaign/day/slot.
- Workspace scoping: every query filtered by URL `workspaceId`; another
  workspace's campaign returns **404** (not 403 — don't leak existence).
- `class-validator` DTOs + global `ValidationPipe` → 400 with field errors on
  bad input (dates, missing name, invalid postType/mode).
- Bad lifecycle transition (e.g. launch with zero filled slots) → 400 with a
  clear message; backend enforces even though frontend preflight also gates.
- Frontend: existing `apiClient` error surfacing + hook `onError` toasts +
  built-in loading/empty/error states. No new frontend error UI.

## Testing

- **Backend (Jest, `*.spec.ts`):** service coverage — create → assembled read
  shape; day/slot CRUD round-trip; metrics + `nextRunAt` computation;
  status-counts keys; workspace-scoping (other-workspace → 404);
  channelIds/platforms union derivation + cache refresh on slot change;
  duplicate resets status/metrics. A happy-path e2e in `test/`.
- **Frontend (no test runner):** `npm run build` (`tsc -b`) + `npx eslint`;
  manual smoke — create → reload (persists) → add day/channel/content →
  reload (slots persist) → launch flips status → duplicate → delete.
- **Full-stack (CLAUDE.md rule 4):** backend `npm run build` + frontend
  `npm run build` both green.

## Branching

- Backend work on a new branch in `socialmedia-workspace`
  (e.g. `feat/campaigns-backend`), off `main` (pull first).
- Frontend swap on a new branch in `socialmedia-frontend`, off `main`.
- The already-pushed `feat/campaigns-simple-builder` (frontend UI) is not
  touched by this effort.

## Risks

- **Schedule → nextRunAt correctness:** the display-only next-run computation
  must honor start/end, skip dates, and skipWeekends across the three schedule
  shapes. Kept display-only in Phase 1 to limit blast radius; Phase 2's real
  scheduler supersedes it.
- **Slot ↔ nested-map assembly:** the read assembly must reproduce the mock's
  nested shape exactly, or the frontend silently misreads. Covered by a
  round-trip service test.
- **workspaceId threading:** the api-function signature change is the one
  place the "mechanical swap" isn't purely mechanical — isolated to
  `campaigns.api.ts` + hook call sites.
