# Composer AI Assist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship an inline AI-assist layer in the post composer (Phase 1): a right-pane Preview⇆AI toggle where a user gives one prompt + tone and gets either a single caption (fills the draft) or per-channel tailored captions (fill per-platform overrides), metered as free-quota → paid, powered by Gemini (primary) with Groq fallback.

**Architecture:** The backend `src/ai/` module already exposes Groq-backed generate endpoints + `AiTokenService` metering. We insert an `AiTextService` (Gemini-primary, Groq-fallback) beneath the existing typed generators so the whole `/ai/*` surface upgrades transparently, add ONE new per-channel orchestration endpoint, and wire the orphaned, mock-backed `AiAssistantPanel` on the frontend into the composer's draft state.

**Tech Stack:** NestJS + Drizzle + class-validator + Jest (BE, `@google/generative-ai` already installed) · React 19 + Vite + TanStack Query + shadcn + Vitest (FE).

**Spec:** `socialmedia-workspace/docs/superpowers/specs/2026-08-19-composer-ai-assist-design.md`

## Global Constraints

- Two repos, both on branch `feat/composer-ai-assist` (off `origin/main`: BE `5804f1d`, FE `54700df`).
- **Provider:** Gemini (`gemini-2.0-flash`, `GOOGLE_AI_API_KEY`) primary, Groq (`GROQ_API_KEY`) fallback for inline. Maestro/Anthropic untouched. If Gemini key absent → silent Groq fallback (no breakage).
- **Metering:** reuse `AiTokenService.executeWithTokens` — FREE plan (`aiTokensPerMonth=0`) → 403; success deducts once; failure deducts nothing. Existing op keys (`caption`/`hashtags`/`improve`/`variations`) reused; ONE new key `generate_per_channel` (cost 8).
- **Scope = composer only.** No inbox AI, no media AI, no Maestro change. Keep the new BE path generic (task-typed) so later phases reuse it.
- Hashtags: append to caption text (no separate hashtags-field UI this phase).
- shadcn-only UI; theme tokens only (no hex/arbitrary Tailwind colors); Form/RHF where forms apply; loading/disabled/empty/error states required.
- Never `git add .`/`-A` (both `.env` files are secret-bearing — FE tracked, BE gitignored). Surgical `git add <path>` only. Commit per task; do not push (controller finishes the branch).
- Verify BE `npm run build` + `npm test`; FE `npm test` + `npm run build`.

---

### Task 1: `AiTextService` — Gemini-primary, Groq-fallback single-shot completion

**Files:**
- Create: `socialmedia-workspace/src/ai/ai-text.service.ts`
- Create: `socialmedia-workspace/src/ai/ai-text.service.spec.ts`
- Modify: `socialmedia-workspace/src/chatbot/llm/gemini.provider.ts` (add a public single-shot `generateText`)
- Modify: `socialmedia-workspace/src/ai/ai.module.ts` (provide/export `AiTextService`; import whatever module exposes `GeminiChatProvider`)

**Interfaces:**
- Produces: `AiTextService.complete(systemPrompt: string, userPrompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>` — tries Gemini `generateText`, on throw/unavailability falls back to Groq. `AiTextService.isReady(): boolean` = Gemini-ready OR Groq-ready. Consumed by Task 2 (Groq methods delegate) and Task 3 (per-channel orchestrator).
- `GeminiChatProvider.generateText(systemPrompt, userPrompt, opts?): Promise<string>` — single `generateContent` call returning text; throws if `!isAvailable()`.

- [ ] **Step 1: Write the failing test** (`ai-text.service.spec.ts`)

Test with mocked providers: (a) when Gemini `generateText` resolves, `complete` returns Gemini's text and Groq is NOT called; (b) when Gemini throws, `complete` returns Groq's text (fallback); (c) when Gemini unavailable AND Groq unavailable, `complete` rejects. Construct `new AiTextService(geminiStub, groqStub)` with jest stubs.

```ts
it('uses Gemini when it succeeds', async () => {
  const gemini = { isAvailable: () => true, generateText: jest.fn().mockResolvedValue('G') } as any;
  const groq = { isReady: () => true, completeRaw: jest.fn() } as any;
  const svc = new AiTextService(gemini, groq);
  await expect(svc.complete('s', 'u')).resolves.toBe('G');
  expect(groq.completeRaw).not.toHaveBeenCalled();
});
it('falls back to Groq when Gemini throws', async () => {
  const gemini = { isAvailable: () => true, generateText: jest.fn().mockRejectedValue(new Error('rl')) } as any;
  const groq = { isReady: () => true, completeRaw: jest.fn().mockResolvedValue('Q') } as any;
  const svc = new AiTextService(gemini, groq);
  await expect(svc.complete('s', 'u')).resolves.toBe('Q');
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd socialmedia-workspace && npx jest ai-text` → FAIL (service/method absent).

- [ ] **Step 3: Add `generateText` to `GeminiChatProvider`**

In `gemini.provider.ts`, add a public method that does one non-chat completion:

```ts
async generateText(
  systemPrompt: string,
  userPrompt: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const genAI = this.ensureGenAI();
  const model = genAI.getGenerativeModel({
    model: this.defaultModel,
    generationConfig: {
      temperature: opts?.temperature ?? 0.7,
      maxOutputTokens: opts?.maxTokens ?? 1024,
    },
    systemInstruction: systemPrompt,
  });
  const result = await model.generateContent(userPrompt);
  return result.response.text();
}
```

- [ ] **Step 4: Add a Groq raw-completion surface for fallback**

`GroqService.generateCompletion` is private. Add a thin public passthrough on `GroqService` so `AiTextService` can call it as the fallback (keep prompt-building in Groq's typed methods; this is just the raw runner):

```ts
async completeRaw(
  systemPrompt: string,
  userPrompt: string,
  opts?: { temperature?: number; maxTokens?: number; model?: string },
): Promise<string> {
  return this.generateCompletion(systemPrompt, userPrompt, opts);
}
```
(Modify `groq.service.ts` for this small addition — list it in this task's files.)

- [ ] **Step 5: Implement `AiTextService`**

```ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { GeminiChatProvider } from '../chatbot/llm/gemini.provider';
import { GroqService } from './groq.service';

@Injectable()
export class AiTextService {
  private readonly logger = new Logger(AiTextService.name);
  constructor(
    private readonly gemini: GeminiChatProvider,
    private readonly groq: GroqService,
  ) {}

  isReady(): boolean {
    return this.gemini.isAvailable() || this.groq.isReady();
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    if (this.gemini.isAvailable()) {
      try {
        return await this.gemini.generateText(systemPrompt, userPrompt, opts);
      } catch (err) {
        this.logger.warn(`Gemini failed, falling back to Groq: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.groq.isReady()) {
      return this.groq.completeRaw(systemPrompt, userPrompt, opts);
    }
    throw new BadRequestException('AI is not configured');
  }
}
```

- [ ] **Step 6: Wire the module** — in `ai.module.ts`, ensure `GeminiChatProvider` is importable (import the chatbot LLM module or add `GeminiChatProvider` to providers if not already exported), add `AiTextService` to providers + exports.

- [ ] **Step 7: Run tests + build** — `npx jest ai-text && npm run build` → PASS.

- [ ] **Step 8: Commit** — surgical add of the 4 files + `ai.module.ts`; `git commit -m "feat(ai): AiTextService with Gemini-primary Groq-fallback completion"`.

---

### Task 2: Route existing Groq generators through `AiTextService` (transparent provider upgrade)

**Files:**
- Modify: `socialmedia-workspace/src/ai/groq.service.ts` (inject `AiTextService`; typed methods delegate completion to it)
- Modify: `socialmedia-workspace/src/ai/groq.service.spec.ts` if present (else no test file change)

**Interfaces:**
- Consumes: `AiTextService.complete` (Task 1).
- Produces: no signature change to `GroqService.generateCaption/generateHashtags/improvePost/generateVariations` — they now run via Gemini-primary path. All existing `/ai/*` endpoints unchanged.

> **Circular-dependency note:** Task 1 has `AiTextService` depend on `GroqService` (for fallback), and this task makes `GroqService` depend on `AiTextService` — a cycle. Resolve by NOT injecting `AiTextService` into `GroqService`. Instead: `GroqService.completeRaw` stays the raw Groq runner (no AiTextService), and the **typed generator methods move their "run completion" call to go through `AiTextService`** only if that doesn't create a cycle. **Chosen, cycle-free approach:** keep `GroqService` as-is (it only ever runs Groq); do the provider-selection in the CONTROLLER/orchestration layer by calling `AiTextService.complete` with Groq's prompt builders. Since prompt-building lives inside `GroqService`'s private methods, extract the prompt strings: add public `buildCaptionPrompt(opts): {system,user}` (and hashtags/improve/variations) to `GroqService` that return the prompt pair WITHOUT running it. Then the controller path calls `AiTextService.complete(prompt.system, prompt.user)`.
>
> **Ruling for the implementer:** implement the extract-prompt-builders approach — add `buildCaptionPrompt`, `buildHashtagsPrompt`, `buildImprovePrompt`, `buildVariationsPrompt` (returning `{ system: string; user: string }`, reusing the existing SYSTEM_PROMPTS/USER_PROMPTS) as public methods on `GroqService`. Do NOT inject `AiTextService` into `GroqService`. Keep the old typed methods (`generateCaption` etc.) intact for any existing callers (e.g. EvergreenService) — they still run pure-Groq, unchanged. New AI-assist code (Task 3) uses the builders + `AiTextService`.

- [ ] **Step 1: Add public prompt-builder methods to `GroqService`**

For caption/hashtags/improve/variations, add `buildXPrompt(opts): { system: string; user: string }` that assemble the same system+user strings the private typed methods use (copy the prompt-assembly lines out of each typed method into the builder; the typed method can then call its builder + `generateCompletion` to stay DRY, but that refactor is optional — minimal path: builders duplicate the assembly, typed methods stay untouched). Prefer: typed method calls `const {system,user}=this.buildXPrompt(opts); return this.postProcess(await this.generateCompletion(system,user,...))` so there's ONE prompt source.

- [ ] **Step 2: Build** — `npm run build` → PASS. (No behavior change yet; this task only exposes builders.)

- [ ] **Step 3: Commit** — `git commit -m "refactor(ai): expose GroqService prompt builders for provider-agnostic use"`.

---

### Task 3: Per-channel orchestrator + endpoint + cost key

**Files:**
- Create: `socialmedia-workspace/src/ai/composer-ai.service.ts`
- Create: `socialmedia-workspace/src/ai/composer-ai.service.spec.ts`
- Modify: `socialmedia-workspace/src/ai/services/ai-token.service.ts` (+`generate_per_channel: 8` in `AI_OPERATION_COSTS`)
- Modify: `socialmedia-workspace/src/ai/dto/ai.dto.ts` (+`GeneratePerChannelDto` + response type)
- Modify: `socialmedia-workspace/src/ai/ai.controller.ts` (+`POST /ai/workspaces/:workspaceId/generate/per-channel`)
- Modify: `socialmedia-workspace/src/ai/ai.module.ts` (provide `ComposerAiService`)

**Interfaces:**
- Consumes: `AiTextService.complete` (T1), `GroqService.buildCaptionPrompt`/`buildVariationsPrompt` (T2), `AiTokenService.executeWithTokens`.
- Produces: `ComposerAiService.generatePerChannel(workspaceId, userId, { description, platforms, tone?, includeHashtags? }): Promise<{ variations: {platform,text,hashtags?}[]; usage }>`. Endpoint returns the same shape. Consumed by FE Task 5.

- [ ] **Step 1: Add the cost key**

In `ai-token.service.ts` `AI_OPERATION_COSTS`, add `generate_per_channel: 8,`.

- [ ] **Step 2: Write the failing test** (`composer-ai.service.spec.ts`)

Mock `AiTextService.complete` to echo the platform, mock `AiTokenService.executeWithTokens` to run the fn and return `{ result, usage: {...} }`. Assert: 3 platforms → 3 `{platform,text}` entries, tone threaded into prompts, `executeWithTokens` called ONCE with op `'generate_per_channel'`.

- [ ] **Step 3: Run it, verify it fails** — `npx jest composer-ai` → FAIL.

- [ ] **Step 4: Implement `ComposerAiService.generatePerChannel`**

```ts
async generatePerChannel(workspaceId, userId, input) {
  const { description, platforms, tone, includeHashtags } = input;
  const { result, usage } = await this.aiTokens.executeWithTokens(
    workspaceId, userId, 'generate_per_channel', platforms.join(','),
    `Per-channel: ${description.substring(0, 80)}`,
    async () => {
      const variations = await Promise.all(
        platforms.map(async (platform) => {
          const { system, user } = this.groq.buildCaptionPrompt({
            description, platform, tone, includeHashtags: !!includeHashtags, includeCta: true,
          });
          const text = await this.aiText.complete(system, user);
          return { platform, text };
        }),
      );
      return { result: { variations }, outputLength: variations.map(v => v.text).join('').length };
    },
  );
  return { ...result, usage };
}
```

- [ ] **Step 5: DTO + endpoint**

`GeneratePerChannelDto`: `@IsString() @IsNotEmpty() description`; `@IsArray() @ArrayMinSize(1) @IsIn(PLATFORMS, { each: true }) platforms`; optional `@IsIn(TONES) tone`; optional `@IsBoolean() includeHashtags`. Controller method mirrors siblings:

```ts
@Post('workspaces/:workspaceId/generate/per-channel')
generatePerChannel(
  @Param('workspaceId') workspaceId: string,
  @Body() dto: GeneratePerChannelDto,
  @CurrentUser() user: { userId: string },
) {
  return this.composerAi.generatePerChannel(workspaceId, user.userId, dto);
}
```

- [ ] **Step 6: Run tests + build** — `npx jest composer-ai ai-token && npm run build` → PASS.

- [ ] **Step 7: Commit** — surgical add; `git commit -m "feat(ai): per-channel caption generation endpoint (metered)"`.

---

### Task 4: `.env.example` + backend verification

**Files:**
- Modify: `socialmedia-workspace/.env.example`

- [ ] **Step 1:** Add `GOOGLE_AI_API_KEY=` (with a comment: "Gemini for inline AI assist; falls back to GROQ_API_KEY if unset") near the other AI keys. Do NOT touch the real `.env`.
- [ ] **Step 2: Full BE verify** — `npm run build && npm test`. Note any pre-existing unrelated failures (do not fix out of scope); the `ai`/`composer-ai`/`ai-text` suites must pass.
- [ ] **Step 3: Commit** — `git add .env.example && git commit -m "docs(ai): document GOOGLE_AI_API_KEY"`.

---

### Task 5: Frontend — API layer + hooks

**Files:**
- Create: `socialmedia-frontend/src/features/composer/api/ai.api.ts`
- Create: `socialmedia-frontend/src/features/composer/hooks/use-ai-generate.ts`
- Create: `socialmedia-frontend/src/features/composer/hooks/use-ai-usage.ts`
- Create: `socialmedia-frontend/src/features/composer/types/ai.ts` (typed request/response mirroring BE DTOs)

**Interfaces:**
- Consumes: BE endpoints `/ai/workspaces/:id/generate/caption`, `/hashtags`, `/improve`, `/generate/per-channel`, `/usage`.
- Produces: `useAiGenerate(workspaceId)` (mutations: `caption`, `perChannel`) and `useAiUsage(workspaceId)` (query → remaining tokens). Consumed by Task 6 (panel).

- [ ] **Step 1:** Add types in `types/ai.ts`: `AiTone`, `PerChannelVariation = { platform: SocialPlatform; text: string; hashtags?: string[] }`, request/response shapes matching the BE DTOs exactly (full-stack consistency).
- [ ] **Step 2:** `ai.api.ts` — typed `apiClient` wrappers for each endpoint (follow existing `composer.api.ts` style).
- [ ] **Step 3:** `use-ai-generate.ts` — TanStack `useMutation`s; `use-ai-usage.ts` — `useQuery` on `/usage` (query key via the feature's key factory pattern). Map a 403 error to a typed `quotaExhausted` flag consumers can read.
- [ ] **Step 4:** FE typecheck — `cd socialmedia-frontend && npx tsc -b` (or `npm run build`) → PASS. (No component yet; this compiles the API/hooks.)
- [ ] **Step 5: Commit** — surgical add; `git commit -m "feat(composer): AI assist API layer + hooks"`.

---

### Task 6: Frontend — wire `AiAssistantPanel` (mode toggle, per-channel cards, quota) + fill draft

**Files:**
- Modify: `socialmedia-frontend/src/features/composer/components/ai-assistant-panel.tsx`
- Remove/replace: `socialmedia-frontend/src/features/composer/lib/ai-mock.ts` (delete once unused)
- Test: `socialmedia-frontend/src/features/composer/components/ai-assistant-panel.test.tsx` (Vitest, `renderToStaticMarkup` per repo norm)

**Interfaces:**
- Consumes: `useAiGenerate`, `useAiUsage` (T5); `useLocalDraft().update` + the per-platform override model.
- Produces: a panel that fills `draft.base.text` (One caption) or per-platform overrides (Per-channel).

- [ ] **Step 1:** Replace `generateMockAiOutput` calls with `useAiGenerate`. Add the **mode toggle** (One caption | Per-channel) using shadcn `Tabs` or `ToggleGroup`.
- [ ] **Step 2:** One-caption result → "Insert into post" calls a prop `onApplyCaption(text)` that the composer wires to `update((prev)=>({ base: { ...prev.base, text } }))`. If `includeHashtags`, append hashtags to the text before applying (per locked decision).
- [ ] **Step 3:** Per-channel → derive selected platforms from `draft.channels` (distinct platforms), call `perChannel` mutation, render one card per returned variation with "Apply to <Platform>" → prop `onApplyToPlatform(platform, text)` (composer writes the per-platform override via the existing `handleEnableCustomize`-style path) + "Apply all".
- [ ] **Step 4:** Quota — `useAiUsage` shows remaining near Generate; on `quotaExhausted` (403) render an upsell empty-state and disable Generate (tooltip). Loading spinner in Generate; error → toast.
- [ ] **Step 5:** Write a Vitest test: panel renders One-caption + Per-channel modes; quota-exhausted state renders the upsell (mock the hooks). Use `renderToStaticMarkup`.
- [ ] **Step 6:** Delete `ai-mock.ts` (confirm no remaining imports).
- [ ] **Step 7:** FE build + test — `npm test && npm run build` → PASS.
- [ ] **Step 8: Commit** — surgical add; `git commit -m "feat(composer): wire AI assist panel to real generation + per-channel"`.

---

### Task 7: Frontend — mount panel via right-pane Preview⇆AI toggle + wire apply handlers

**Files:**
- Modify: `socialmedia-frontend/src/features/composer/components/right-pane-tabs.tsx` (add Preview⇆AI toggle)
- Modify: `socialmedia-frontend/src/features/composer/pages/composer-page.tsx` (pass `onApplyCaption`/`onApplyToPlatform` handlers wired to `useLocalDraft` + the existing customize path; provide selected platforms + workspaceId to the panel)

**Interfaces:**
- Consumes: `AiAssistantPanel` (T6), `useLocalDraft` handlers already present in `composer-page.tsx` (`handleEnableCustomize`, `handlePlatformTextChange`).

- [ ] **Step 1:** Add a segment/toggle at the top of the right pane: **Preview** (existing `PreviewPane`/`ChannelTabBar` machinery, unchanged) | **✨ AI Assist** (renders `AiAssistantPanel`). Default = Preview. Use shadcn `ToggleGroup`/`Tabs`; theme tokens only.
- [ ] **Step 2:** In `composer-page.tsx`, implement `onApplyCaption(text)` → `update((prev)=>({ base: { ...prev.base, text } }))`; `onApplyToPlatform(platform, text)` → reuse the existing enable-customize + set-override flow (snapshot base → set `perPlatform[platform].overrides.text`) so it matches manual customization exactly. Pass selected platforms (distinct from `draft.channels`) + `workspaceId` into the panel.
- [ ] **Step 3:** Manual-ish check via build + existing tests; ensure switching to Preview after Apply shows the applied text.
- [ ] **Step 4:** FE build + test — `npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** — surgical add; `git commit -m "feat(composer): mount AI assist via right-pane Preview/AI toggle"`.

---

### Task 8: Full-stack verification

- [ ] **Step 1:** BE `npm run build && npm test` (ai suites green; note pre-existing unrelated failures only).
- [ ] **Step 2:** FE `npm test && npm run build`.
- [ ] **Step 3:** Record result in ledger. Manual E2E (real `GOOGLE_AI_API_KEY`, PRO workspace) is a post-merge deploy step: generate caption → fills field; per-channel → apply → override set → publish; exhaust quota → upsell; non-English prompt → quality multilingual copy. Note it as pending for the user.
