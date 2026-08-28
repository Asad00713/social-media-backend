# Composer AI Assist — Design

**Date:** 2026-08-19
**Branch:** `feat/composer-ai-assist` (both repos)
**Type:** Architectural (new inline-AI path + provider upgrade + FE wiring)
**Plan of record:** approved plan at `~/.claude/plans/glimmering-squishing-token.md`

## Problem & goal

Schedura (`schedura.ai`) promises AI throughout. It already ships **Maestro** (paid, agentic, conversational). We want an **inline assist** layer — fast, single-shot, in-context — that fills the composer's real fields, WITHOUT duplicating Maestro's chat model. Phase 1 (this effort) = **composer only**: generate a caption + hashtags, and produce **per-channel tailored variations**, metered as a free-quota → paid feature.

Most of the backend already exists (`src/ai/` module: Groq-backed generators + `AiTokenService` metering + live `/ai/*` endpoints) and the composer already has a built-but-orphaned `AiAssistantPanel` (mock-backed). This is mostly **wiring + a provider upgrade + one new orchestration endpoint**, not a from-scratch build.

## Locked decisions

- **UX = generate-fills-fields** (not a chatbot). Results write into `useLocalDraft` and per-platform overrides; fields stay editable.
- **Provider = Gemini Flash primary, Groq fallback** for inline. Maestro stays Anthropic. Gemini provider is already built (`GeminiChatProvider`, `@google/generative-ai`, `gemini-2.0-flash`); needs `GOOGLE_AI_API_KEY` + a single-shot helper.
- **Per-channel variations = AI auto per-platform + user tone override.**
- **Pricing = free monthly quota → paid**, via the existing `AiTokenService.executeWithTokens` metering (FREE plan `aiTokensPerMonth=0` → `ForbiddenException`; PRO 10k/mo). New per-op cost keys added.
- **Scope this branch = composer only.** Inbox/media are later branches; backend kept generic so they reuse it.

## Backend design

### 1. Provider abstraction (Gemini primary, Groq fallback)

Add a **single-shot text helper on the Gemini side** and a thin selector so inline generation prefers Gemini and falls back to Groq on error/unavailability. Two options considered:

- **(A) Route through `LLMRouterService`** with `preferredProvider:'gemini'`. Rejected for inline: that router is chat/tool-calling oriented (`LLMMessage[]`), heavier than needed, and `GroqService`'s typed generators already encode the right system prompts.
- **(B, chosen) Add `generateCompletion` to a Gemini single-shot path + a fallback wrapper.** Concretely:
  - Add a public `generateText(systemPrompt, userPrompt, options?)` to `GeminiChatProvider` (or a small `GeminiTextService`) that calls `model.generateContent` once and returns the string — mirroring `GroqService.generateCompletion`'s contract (which is private today; expose an internal-callable equivalent or keep Groq's public typed methods as the fallback surface).
  - Introduce an **`AiTextService`** in `src/ai/` that owns the "run one system+user prompt, get text" primitive with **Gemini→Groq fallback**: try Gemini `generateText`; on throw or unavailability, call Groq's `generateCompletion`-equivalent. Log which provider served the call.
  - **Refactor `GroqService`'s public typed methods** (`generateCaption`, `generateHashtags`, `improvePost`, `generateVariations`) to obtain their completion via `AiTextService` instead of calling `this.generateCompletion` directly — so every existing `/ai/*` endpoint transparently gains Gemini-primary + Groq-fallback with **no controller/DTO change**. `GroqService` keeps its prompt-building; only the "who runs the completion" line changes. (If cleaner, move prompt-building into `AiTextService` callers; but minimal-diff route is: `AiTextService.complete(system,user,opts)` and Groq methods delegate to it.)
  - `AiTextService` exposes `isReady()` = Gemini-ready OR Groq-ready.

This keeps the whole existing `/ai/*` surface working, upgrades quality/reliability globally, and gives the new per-channel endpoint the same path.

### 2. Per-channel variation orchestration (new)

`GroqService.generateVariations(content, platform, count)` makes N variants of one caption for one platform. It has no concept of the workspace's connected channels. Add an orchestrator:

- **New method** (in a new `ComposerAiService` in `src/ai/`, or on `AiTextService`): `generatePerChannel({ description, platforms: Platform[], tone?, includeHashtags? })` → returns `{ platform: Platform; text: string; hashtags?: string[] }[]`.
- Implementation: for each requested platform, call the caption path with that platform + tone (AI auto-applies platform norms via the existing platform-aware system prompts; `tone` overrides when supplied). Run platforms concurrently (`Promise.all`), bounded to the requested list (composer selection is small — a handful of platforms).
- **Metering:** the whole per-channel call is ONE `executeWithTokens` unit priced by a new op key (below), NOT one deduction per platform — simpler for the user, and matches "one generate action." `outputLength` = joined length of all variations.

### 3. New endpoint

Add to `src/ai/ai.controller.ts` (same `@Controller('ai')`, `@UseGuards(JwtAuthGuard)`, `:workspaceId` param — note: this controller is NOT workspace-role-guarded today; keep consistent with siblings, metering is the gate):

```
POST /ai/workspaces/:workspaceId/generate/per-channel
body: { description: string; platforms: Platform[]; tone?: Tone; includeHashtags?: boolean }
resp: { variations: { platform: Platform; text: string; hashtags?: string[] }[]; usage: TokenDeductResult }
```

New DTO `GeneratePerChannelDto` in `src/ai/dto/ai.dto.ts` (class-validator: `@IsString() description`, `@IsArray() @IsIn(PLATFORMS,{each:true}) platforms`, optional `tone`/`includeHashtags`). Response DTO mirrors the shape.

### 4. Operation cost keys

Add to `AI_OPERATION_COSTS` (`src/ai/services/ai-token.service.ts`): `generate_per_channel` (cost ~8, it fans out). The existing `caption`/`hashtags`/`improve`/`variations` keys already exist and are reused unchanged for the single-field generate. (No `inline_*` rename — reuse existing keys to avoid double-defining; only the genuinely-new per-channel op is added.)

### 5. Env

Add `GOOGLE_AI_API_KEY` to backend `.env.example` (documented). Real key set on Railway at deploy. If the key is absent, `AiTextService` silently falls back to Groq — no breakage.

### Backend explicitly out of scope
- No inbox AI (`suggestReply`) this branch.
- No change to Maestro / `TokenTrackingService`.
- No new usage-*count* metering (we meter tokens via the existing path, not a new `UsageService` ResourceType).

## Frontend design

### UX flow (locked)

The user clicks a right-pane toggle to switch the pane between **Preview** and **✨ AI Assist** (see mount below). The AI panel is a **single-shot form, NOT a chat** (AI never asks follow-up questions — that's Maestro's job):
1. Prompt box: "What's this post about?"
2. Tone chips (professional/playful/bold/casual…) — the AI-auto default per platform, user override.
3. Mode toggle: **One caption** | **Per-channel**.
4. Generate (spinner, disabled while pending / when quota exhausted; quota shown near it).
5. **One caption** → result card with **Insert into post** (writes `draft.base.text`) + Regenerate.
6. **Per-channel** → one card per currently-selected platform (from `draft.channels` distinct platforms), each tailored (Twitter short, LinkedIn formal, IG emoji-heavy…), each with **Apply to <Platform>** (writes that platform's override) + **Apply all**.

### 1. Wire the orphaned `AiAssistantPanel`

`AiAssistantPanel` (`src/features/composer/components/ai-assistant-panel.tsx`) is fully built (prompt Textarea, tone picker, Generate, Copy, Insert) but mock-backed and unmounted. Changes:
- Replace `generateMockAiOutput` (`lib/ai-mock.ts`) with a real API call.
- Add the **mode toggle** (One caption | Per-channel) and the per-channel result cards to the panel.
- Add an API module `src/features/composer/api/ai.api.ts` (typed `apiClient` wrappers): `generateCaption`, `generateHashtags`, `improve`, `generatePerChannel`, `getAiUsage` — hitting the `/ai/workspaces/:id/...` endpoints.
- Add hooks `src/features/composer/hooks/use-ai-generate.ts` (+ `use-ai-usage.ts`) — TanStack `useMutation`/`useQuery`.

### Mount — right-pane Preview ⇆ AI toggle

Add a **toggle/segment at the top of the right pane** (`right-pane-tabs.tsx` / its container) with two modes: **Preview** (current channel-preview cards, unchanged) and **✨ AI Assist** (the panel). One pane, two modes — generate on AI, switch to Preview to see it land. This is layered ON TOP of the existing channel `ChannelTabBar`/preview machinery, not a replacement — the channel tabs still drive which platform preview shows in Preview mode.

### 2. Write results into the draft (fills fields)

- Single caption → `update((prev)=>({ base: { ...prev.base, text: <generated> } }))` via `useLocalDraft`.
- Hashtags → the composer doesn't wire `base.hashtags` to UI today; simplest Phase-1 behavior: **append hashtags to the caption text** (matches how users add hashtags now — inline in the body). (Wiring a separate hashtags field is out of scope.)
- The panel's existing "Insert into post" (`onInsert`) is the natural hook — repoint it to `update`.

### 3. Per-channel variations surface

- Extend the panel's output: a **"Per-channel" mode** that calls `generatePerChannel` with the composer's currently-selected platforms (derived from `draft.channels` distinct platforms) + chosen tone.
- Render **one card per platform** (reuse platform badges/labels), each with the tailored caption and an **"Apply to <Platform>"** action that writes into the per-platform override: `update((prev)=>({ perPlatform: { ...prev.perPlatform, [platform]: enableCustomizeWith(text) } }))` — following the existing `handleEnableCustomize`/`platform-tab.tsx` override model (snapshot base → set `overrides.text`).
- "Apply all" convenience writes every card into its platform override.

### 4. Quota surfacing

- `useAiUsage` reads `GET /ai/workspaces/:id/usage` → remaining tokens/generations.
- Show remaining count near the Generate button; when the plan gates (FREE = 0) or tokens exhausted, the endpoint returns 403 → render an **empty/upsell state** ("You've used your free AI generations — upgrade for more") reusing existing billing-upgrade UI patterns. Generate button disabled + tooltip when exhausted.
- Loading/disabled/error states per the composer's polish rules (spinner in button, toast on error).

### FE out of scope
- Inbox ✨ button (Phase 2). Media (Phase 3). Separate hashtags-field UI. Streaming.

## Error & edge handling
- Gemini error/rate-limit → Groq fallback (backend, transparent to FE).
- Both providers down → endpoint 400 "AI is not configured"; FE toasts a friendly error.
- 403 (plan/quota) → FE upsell state, NOT a generic error toast.
- Empty prompt → client-side validation (panel already disables Generate on empty).
- Multilingual: verify a non-English prompt returns quality copy (international requirement) — Gemini's strength; part of manual E2E.

## Testing
**Backend (Jest):**
- `AiTextService`: Gemini primary used when ready; Groq fallback on Gemini throw; both-unready → throws. (Mock both providers.)
- Per-channel orchestrator: N platforms → N `{platform,text}` entries; tone passed through; one `executeWithTokens` unit.
- Metering: FREE plan (0 tokens) → 403; success deducts once; failure deducts nothing (reuse existing `AiTokenService` test patterns).
- New DTO validation (bad platform rejected).

**Frontend (Vitest):**
- API/hook wiring shape; per-channel result maps to cards; apply-to-channel writes the right `perPlatform` override shape; quota-exhausted state renders on 403.

## Files
**Backend:** `src/ai/ai-text.service.ts` (new), `src/ai/composer-ai.service.ts` (new, or fold into ai-text), `src/chatbot/llm/gemini.provider.ts` (add single-shot `generateText`), `src/ai/groq.service.ts` (delegate completion to AiTextService), `src/ai/services/ai-token.service.ts` (+`generate_per_channel` cost), `src/ai/ai.controller.ts` (+per-channel route), `src/ai/dto/ai.dto.ts` (+DTOs), `src/ai/ai.module.ts` (wire new services), `.env.example` (+`GOOGLE_AI_API_KEY`). Tests co-located `*.spec.ts`.
**Frontend:** `src/features/composer/api/ai.api.ts` (new), `src/features/composer/hooks/use-ai-generate.ts` + `use-ai-usage.ts` (new), `src/features/composer/components/ai-assistant-panel.tsx` (rewire + per-channel + quota), mount point in `right-pane-tabs.tsx`, remove/replace `src/features/composer/lib/ai-mock.ts`. Tests co-located.

## Verification
- BE `npm run build` + `npm test`; FE `npm test` + `npm run build`.
- Manual E2E with a real `GOOGLE_AI_API_KEY` in a PRO test workspace: generate caption → fills field; per-channel → cards → apply → per-platform override set → publish; exhaust quota → upsell; non-English prompt → quality multilingual copy.
- Standing rules: backend-first; surgical `git add`; both `.env` files untracked-safe; ship to `main`.
