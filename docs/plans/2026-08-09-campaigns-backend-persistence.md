# Campaigns Backend — Persistence & CRUD (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real NestJS `CampaignsModule` (3 Drizzle tables + CRUD + lifecycle) that reproduces the frontend mock store's exact behavior and `Campaign` shape, then swap the frontend from mock → real API so campaigns persist in Postgres.

**Architecture:** Mirror the `drips` module. Three tables (`campaigns`, `campaign_days`, `campaign_slot_content`); the service assembles the nested `SlotContentMap` on read and computes `metrics` + `nextRunAt` (not stored); `channelIds`/`platforms` are cached columns refreshed on slot changes. Frontend swap replaces `store.*` calls in `campaigns.api.ts` with `apiClient` calls, threading `workspaceId` from hooks.

**Tech Stack:** NestJS, Drizzle ORM (node-postgres, `import { db }`), `class-validator` DTOs, Jest (backend). Frontend: Vite/React/TanStack Query, `apiClient` (`lib/api.ts`).

## Global Constraints

- **Two repos.** Backend tasks touch `socialmedia-workspace` (branch `feat/campaigns-backend`). Frontend tasks touch `socialmedia-frontend` (its own new branch off `main`). Each task header names its repo. Never mix repos in one commit.
- **Reproduce the mock contract exactly.** The authoritative behavior + shapes are in the frontend `campaigns-mock-store.ts` and `types/campaign.ts` + `types/slot-content.ts`. The assembled `Campaign` the backend returns must be byte-identical in shape (field names, nesting, nullability) so the frontend needs zero type changes.
- **Route surface matches the mock's REST comments:** prefix `campaigns`, workspace-scoped `campaigns/workspaces/:workspaceId/...`. All endpoints `@UseGuards(JwtAuthGuard)` + `@CurrentUser()`.
- **DB access pattern:** `import { db } from '../drizzle/db'` + direct Drizzle (`eq/and/desc`), exactly like `drip.service.ts`. Module imports `DrizzleModule`.
- **Computed on read, never stored:** `metrics` (postsPlanned = filled non-skipped slots; published/failed/skipped = 0 in Phase 1), `nextRunAt` (display-only next firing when active/scheduled, else null). `channelIds`/`platforms` are cached columns, recomputed (union across slots, skipping unresolvable channels) on every slot mutation.
- **Workspace scoping:** every query filtered by URL `workspaceId`; another workspace's campaign → **404** (NotFoundException), never 403.
- **DTOs:** `class-validator`, global `ValidationPipe` whitelist is on. Create is Simple/`bulk` only.
- **Phase 1 boundaries:** `launch/pause/resume` flip status only (no BullMQ, no PublisherFactory). AI-slot endpoints reproduce the mock caption behavior (no real LLM).
- **Verification:** backend `npm run build` + `npm run test` (relevant specs) green; frontend `npm run build` (`tsc -b`) + `npx eslint` clean. Migrations via `npm run db:generate` (do NOT hand-write migration SQL).
- **Do not** `git add .`/`-A`; stage explicit paths; never touch any `.env`. Commit per task; do not push (user batches pushes).

---

### Task 1: Drizzle schema — 3 campaign tables

**Repo:** `socialmedia-workspace`

**Files:**
- Create: `src/drizzle/schema/campaigns.schema.ts`
- Modify: `src/drizzle/schema/index.ts` (add `export * from './campaigns.schema';`)

**Interfaces:**
- Produces: `campaigns`, `campaignDays`, `campaignSlotContent` tables + inferred types (`Campaign`, `NewCampaign`, `CampaignDay`, `CampaignSlotContent`, …) + status/type const arrays. Task 2 (service) consumes these.

- [ ] **Step 1: Write the schema file**

Create `campaigns.schema.ts` following `drips.schema.ts` conventions (imports from `drizzle-orm/pg-core`, `relations`, FKs to `workspace`/`users`). Define:

```ts
export const CAMPAIGN_TYPES = ['bulk', 'drip', 'evergreen'] as const
export type CampaignTypeDb = (typeof CAMPAIGN_TYPES)[number]

export const CAMPAIGN_STATUSES = ['draft','scheduled','active','paused','completed','failed'] as const
export type CampaignStatusDb = (typeof CAMPAIGN_STATUSES)[number]
```

`campaigns` table columns (per spec §Data model):
- `id` uuid pk defaultRandom; `workspaceId` uuid notNull FK→workspace (cascade); `createdById` uuid notNull FK→users (set null)
- `name` varchar(255) notNull; `description` text
- `type` varchar(20) notNull; `status` varchar(20) default 'draft' notNull
- `schedule` jsonb notNull `$type<CampaignScheduleJson>()` (define a local `CampaignScheduleJson` type = the union of bulk/drip/evergreen shapes mirroring the frontend `CampaignSchedule`)
- `contentSource` varchar(20) default 'manual' notNull
- `aiConfig` jsonb `$type<Record<string, unknown> | null>()`  (AiAutopilotConfig; kept loose server-side)
- `libraryTemplateIds` jsonb `$type<string[]>()` default `[]`
- `channelIds` jsonb `$type<string[]>()` default `[]` notNull  (cache)
- `platforms` jsonb `$type<string[]>()` default `[]` notNull   (cache)
- `createdAt`/`updatedAt` timestamp defaultNow notNull

`campaignDays` table:
- `id` uuid pk; `campaignId` uuid notNull FK→campaigns (cascade)
- `date` varchar(10) notNull  (yyyy-MM-dd)
- `skip` boolean default false notNull
- `createdAt` timestamp defaultNow notNull
- unique index on `(campaignId, date)` via `uniqueIndex`

`campaignSlotContent` table:
- `id` uuid pk; `campaignId` uuid notNull FK→campaigns (cascade)
- `date` varchar(10) notNull; `channelId` varchar(255) notNull
- `content` jsonb notNull `$type<ChannelDayContentJson>()` (define `ChannelDayContentJson` mirroring frontend `ChannelDayContent`: mode, postType, caption, media[], threadParts[], poll?, templateIds[], aiSubState?, platformSpecific?)
- `createdAt`/`updatedAt` timestamp defaultNow notNull
- unique index on `(campaignId, date, channelId)`

Add `relations()` for all three (campaign → many days, many slots; day/slot → one campaign) following the drips relations style. Export inferred types (`$inferSelect`/`$inferInsert`).

- [ ] **Step 2: Register in the schema barrel**

Add to `src/drizzle/schema/index.ts`:
```ts
export * from './campaigns.schema';
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new migration file under `drizzle/migrations/` with the 3 tables. Do NOT hand-edit it.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (0 TS errors).

- [ ] **Step 5: Commit**

```
git add src/drizzle/schema/campaigns.schema.ts src/drizzle/schema/index.ts drizzle/migrations
git commit -m "feat(campaigns): drizzle schema — campaigns, days, slot_content tables"
```
End the body with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 2: Campaign assembly + read service

**Repo:** `socialmedia-workspace`

**Files:**
- Create: `src/campaigns/campaigns.service.ts` (read half + assembly; write half added in Task 3)
- Create: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 tables/types; `db`; `socialMediaChannels` (from `channels.schema`) for platform resolution.
- Produces: `CampaignsService` with read methods + the assembly helper. Signatures Task 3/4 rely on:
  - `assembleCampaign(campaignId): Promise<CampaignDto>` — builds the nested `Campaign` shape (row + days + slots → `slotContent` map) + computed `metrics` + `nextRunAt`.
  - `list(workspaceId, {status?, search?}): Promise<CampaignDto[]>`
  - `getOne(workspaceId, id): Promise<CampaignDto>` (404 if missing/other-ws)
  - `statusCounts(workspaceId): Promise<Record<string, number>>`
  - `computeMetrics(days, slots)`, `computeNextRun(schedule, status)`, `isSlotFilled(content)` helpers.

- [ ] **Step 1: Define the response DTO/type**

In `campaigns.service.ts` (or a `campaigns.types.ts` if cleaner), define `CampaignDto` = the exact frontend `Campaign` shape: `{ id, workspaceId, name, description, type, status, channelIds, platforms, schedule, contentSource, aiConfig, libraryTemplateIds, slotContent, metrics, createdAt, updatedAt, nextRunAt }`. `slotContent` is `Record<date, { channelContent: Record<channelId, ChannelDayContentJson>, skip?: boolean }>`.

- [ ] **Step 2: Write failing tests for assembly + computed fields**

`campaigns.service.spec.ts` — test the pure helpers (no DB needed for these):
```
- isSlotFilled: ai → true; library with templateIds → true; manual text with caption → true; empty manual → false; poll with question → true
- computeMetrics: postsPlanned counts filled slots on non-skipped days only; published/failed/skipped = 0
- computeNextRun: returns null when status draft/paused/completed; returns a next firing for active bulk within range; null when range fully in past
```
Mock `db`? For pure helpers, call them directly with in-memory day/slot arrays — no DB. (Assembly-with-DB is covered by the round-trip test in Task 3.)

- [ ] **Step 3: Run tests — verify they fail**

Run: `npm run test -- campaigns.service`
Expected: FAIL (methods not defined).

- [ ] **Step 4: Implement the read service + helpers**

- `isSlotFilled(content)` — port the frontend `isChannelDayFilled` logic (ai→true, library→templateIds.length>0, poll→question, thread/text→caption or media).
- `computeMetrics(days, slots)` — postsPlanned = filled slots whose date is a non-skipped day; others 0.
- `computeNextRun(schedule, status)` — display-only: if status not in (`active`,`scheduled`) → null; else compute the next date/time ≥ now within start–end honoring skipWeekends/blackoutDates/weekdays per schedule type; null if none.
- `assembleCampaign(id)` — load campaign row + its days + slots; build nested `slotContent`; attach computed metrics + nextRun + cached channelIds/platforms → `CampaignDto`.
- `list/getOne/statusCounts` — workspace-scoped Drizzle queries; `getOne` throws `NotFoundException` when missing or wrong workspace; `statusCounts` returns all 7 keys (`all` + 6 statuses).

- [ ] **Step 5: Run tests — verify pass**

Run: `npm run test -- campaigns.service`
Expected: PASS.

- [ ] **Step 6: Build + commit**

Run: `npm run build` (PASS). Then:
```
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): read service — assembly, metrics, next-run"
```
End body with the Co-Authored-By line.

---

### Task 3: Write service — CRUD, lifecycle, days & slots

**Repo:** `socialmedia-workspace`

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (add write half)
- Modify: `src/campaigns/campaigns.service.spec.ts` (add a DB round-trip test if a test DB is available; otherwise assert the cache-recompute + duplicate-reset logic on helper level)

**Interfaces:**
- Consumes: Task 2 read half + assembly.
- Produces write methods (all return the assembled `CampaignDto`, mirroring the mock):
  - `createSimple(workspaceId, userId, dto)`, `update(workspaceId, id, patch)`, `remove(workspaceId, id)`
  - `launch/pause/resume/duplicate(workspaceId, id)`
  - `addDay/removeDay/setDaySkip(workspaceId, id, date, [skip])`
  - `addEvent(workspaceId, id, {date, channelId, postType?, platform?})`, `updateEvent(workspaceId, id, {date, channelId, patch})`, `removeEvent(workspaceId, id, {date, channelId})`
  - `generateAi/approveAi/skipAi(workspaceId, id, {date, channelId})` — Phase 1 mock caption
  - private `refreshChannelCache(campaignId)` — recompute channelIds/platforms union from slots.

- [ ] **Step 1: Implement write methods**

Follow the mock semantics exactly:
- `createSimple` → insert a `bulk` draft with the given schedule; empty days/slots; return assembled.
- `update` → patch name/description/contentSource/aiConfig + bulk schedule fields (defaultTime/skipWeekends/blackoutDates); accept channelIds/platforms in DTO but they're overwritten by `refreshChannelCache` on next slot change.
- `addEvent` → upsert a slot row (`emptyChannelDayContent(postType, campaign.contentSource)` shape), ensure the day row exists, then `refreshChannelCache`.
- `updateEvent` → merge `patch` into the slot's `content` jsonb (spread over existing); 404 if slot missing.
- `setDaySkip`/`addDay`/`removeDay` → `campaignDays` rows.
- `duplicate` → copy row + days + slots under a new id, name `"… (copy)"`, status `draft`, reset nothing else (metrics are computed anyway).
- `generateAi/approveAi/skipAi` → mutate the slot's `content` jsonb: set `mode:'ai'`, mock caption when empty, `aiSubState` per `aiConfig.approvalMode` (approve→approved, skip→skipped). Reproduce `mockAiCaption` from the mock store.
- `refreshChannelCache` → union of `channelId` across all slot rows; resolve platforms via `socialMediaChannels` (skip unresolved); write both cache columns.

- [ ] **Step 2: Tests**

Add a round-trip test if the test harness has a DB; otherwise unit-test `refreshChannelCache` union logic and the AI-state transitions with in-memory inputs. Run: `npm run test -- campaigns.service` → PASS.

- [ ] **Step 3: Build + commit**

`npm run build` (PASS). Then:
```
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): write service — CRUD, lifecycle, days & slots"
```
Co-Authored-By line.

---

### Task 4: Controller + DTOs + module registration

**Repo:** `socialmedia-workspace`

**Files:**
- Create: `src/campaigns/campaigns.controller.ts`
- Create: `src/campaigns/dto/campaigns.dto.ts`
- Create: `src/campaigns/campaigns.module.ts`
- Modify: `src/app.module.ts` (import + register `CampaignsModule`)

**Interfaces:**
- Consumes: `CampaignsService` (Tasks 2–3).
- Produces: the REST surface (spec §API mapping). Task 5 (frontend) targets these routes.

- [ ] **Step 1: DTOs**

`campaigns.dto.ts` with `class-validator`:
- `CreateSimpleCampaignDto` — name (IsString), description? , startDate/endDate (IsDateString), timezone (IsString), defaultTime (Matches HH:mm), skipWeekends (IsBoolean).
- `UpdateCampaignDto` — all optional (name, description, channelIds[], platforms[], contentSource enum, aiConfig object, scheduleDefaultTime, skipWeekends, blackoutDates[]).
- `ListCampaignsQueryDto` — status? (enum incl. 'all'), search?.
- `AddDayDto` {date}, `SetDaySkipDto` {skip}, `AddEventDto` {date, channelId, postType?, platform?}, `UpdateEventDto` {date, channelId, patch (IsObject)}, `RemoveEventDto` {date, channelId}, `AiEventDto` {date, channelId}.

- [ ] **Step 2: Controller**

`@Controller('campaigns')` + `@UseGuards(JwtAuthGuard)`. Endpoints per spec table, each delegating to the service and returning `{ ...assembledCampaign }` (or `Campaign[]` / counts). Use `@Param('workspaceId')`, `@CurrentUser()`, `@Body()`, `@Query()`. Mirror the drip controller's method style.

- [ ] **Step 3: Module + register**

`campaigns.module.ts` imports `DrizzleModule`, provides+controllers CampaignsService/Controller, exports the service. Add to `app.module.ts` imports.

- [ ] **Step 4: Build + basic e2e happy path**

Run: `npm run build` (PASS). Add a minimal e2e in `test/` (or a controller spec) covering create → get → addDay → addEvent → updateEvent → launch, asserting the assembled shape + status. Run: `npm run test` (relevant) → PASS.

- [ ] **Step 5: Commit**

```
git add src/campaigns/campaigns.controller.ts src/campaigns/dto/campaigns.dto.ts src/campaigns/campaigns.module.ts src/app.module.ts test
git commit -m "feat(campaigns): controller, DTOs, module registration"
```
Co-Authored-By line.

---

### Task 5: Frontend swap — mock → real API

**Repo:** `socialmedia-frontend` (new branch off `main`)

**Files:**
- Modify: `src/features/campaigns/api/campaigns.api.ts`
- Modify: `src/features/campaigns/hooks/use-campaigns.ts` + `use-campaign-event-mutations.ts` (thread `workspaceId`)
- Delete: `src/features/campaigns/store/campaigns-mock-store.ts`, `src/features/campaigns/hooks/mock-campaigns.ts`

**Interfaces:**
- Consumes: the backend routes (Task 4); existing `apiClient` (`lib/api.ts`), `useWorkspaceId`.
- Produces: `campaignsApi.*` backed by real HTTP; same return types (frontend `Campaign`), so components are unchanged.

- [ ] **Step 1: Rewrite `campaigns.api.ts`**

Each function takes `workspaceId` as its first arg and calls `apiClient` against `campaigns/workspaces/${workspaceId}/...`. Keep the return types (`Campaign`, `Campaign[]`, counts). Preserve method names. Remove the `store` import + the `CreateSimpleCampaignInput`/`UpdateCampaignPatch` re-export from the store — move those types into the api file (or `types/`) so nothing imports the deleted store.

- [ ] **Step 2: Thread `workspaceId` through hooks**

`use-campaigns.ts` + the event-mutations hook already run in components; call `useWorkspaceId()` and pass it into each `campaignsApi.*` call. Guard: if `workspaceId` is null, disable the query (`enabled: !!workspaceId`) — matches how other features gate.

- [ ] **Step 3: Delete the mock**

Remove `campaigns-mock-store.ts` + `mock-campaigns.ts`. Fix any remaining imports (there should be none outside the api file after Step 1).

- [ ] **Step 4: Build + lint**

Run: `npm run build` (`tsc -b`, PASS). Run: `npx eslint src/features/campaigns` (clean — no dangling imports to the deleted store).

- [ ] **Step 5: Commit**

```
git add src/features/campaigns/api/campaigns.api.ts src/features/campaigns/hooks/use-campaigns.ts src/features/campaigns/hooks/use-campaign-event-mutations.ts
git rm src/features/campaigns/store/campaigns-mock-store.ts src/features/campaigns/hooks/mock-campaigns.ts
git commit -m "feat(campaigns): swap listing/builder from mock store to real API"
```
Co-Authored-By line.

---

## Self-Review

**1. Spec coverage:**
- 3 tables → Task 1. ✓
- CRUD + lifecycle + days/slots + AI-mock endpoints → Tasks 2–4. ✓
- metrics/nextRunAt computed-on-read; channelIds/platforms cache → Task 2 (helpers) + Task 3 (refreshChannelCache). ✓
- REST surface matching mock → Task 4 controller. ✓
- Frontend swap + delete mock + workspaceId seam → Task 5. ✓
- Errors (404 workspace-scoped, class-validator) → Task 2 getOne + Task 4 DTOs. ✓
- Out of scope (publish/AI) → not in any task; launch = status flip, AI = mock caption. ✓

**2. Placeholder scan:** No TBD/TODO. Each step names files, columns, method signatures, test cases. Migration generated (not hand-written). ✓

**3. Type consistency:**
- `CampaignDto` (Task 2) = frontend `Campaign` shape; controller returns it (Task 4); frontend consumes unchanged (Task 5). ✓
- Service method signatures declared in Task 2/3 Interfaces match controller call sites (Task 4) and frontend api calls (Task 5). ✓
- `isSlotFilled` (backend) ports `isChannelDayFilled` (frontend) — same rules. ✓
- Schema inferred types (Task 1) consumed by service (Task 2/3). ✓

**Cross-repo note:** Tasks 1–4 = backend (`feat/campaigns-backend`); Task 5 = frontend (own branch). SDD executes them in order; the frontend task can only be manually smoke-tested against a running backend, so its "verification" is build+lint+code-trace, with live E2E flagged for the user.
