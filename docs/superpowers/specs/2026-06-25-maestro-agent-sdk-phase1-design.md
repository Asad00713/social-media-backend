# Maestro Agent — Phase 1 Design (Claude Agent SDK)

**Date:** 2026-06-25
**Branch:** `feat/maestro-agent-sdk` (backend + frontend)
**Status:** Approved for implementation (Phase 1 only)

## 1. Goal & Scope

Build the foundation of "Maestro" — an in-app AI agent that will eventually do
**everything a user can do on the platform** (a "human replica"): chat, tool
calls, page navigation, theme change, post create/schedule/publish, web search,
prompt enhancement, MCP connectors (Calendar/Drive/Slack + user-custom),
external channels (WhatsApp/Telegram), voice (STT), and multi-model media
generation.

**Phase 1 is deliberately small.** It builds the *foundation* on the Claude
Agent SDK and ships only:

- Basic streaming chat through `@anthropic-ai/claude-agent-sdk`'s `query()`.
- **Two read-only tools**: `get_user_profile`, `get_workspace_info` (so the UI
  can render real tool-call + tool-result chips).
- Thinking / tool-call / tool-result events streamed to the existing Maestro UI.
- An auth switch: **Max-plan OAuth (dev) ↔ `ANTHROPIC_API_KEY` (prod)**.
- Stateless persistence reusing the existing chatbot conversation tables.

Everything else (Phases 2–5) is **out of scope** but the architecture must let
them slot in as "new tools / new MCP servers / new channel adapters" without
touching the core loop.

### Non-goals (Phase 1)
- No action tools (navigate/theme/post) — Phase 2.
- No external MCP connectors or skills — Phase 3.
- No external channels or voice — Phase 4.
- No image/video model routing — Phase 5.
- No replacement of the existing `ChatbotModule` — it keeps running untouched.

## 2. Key Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Surface | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` v0.3.x) |
| 2 | Why Agent SDK over Messages API | Uses the user's **Claude Max subscription** auth (no separate API-key billing); native path to skills/MCP/sub-agents for the larger vision |
| 3 | Build approach | **New parallel module** (`src/maestro/`), existing `ChatbotModule` untouched |
| 4 | Persistence | **Reuse existing chatbot conversation tables**, stateless DB-replay per turn |
| 5 | Phase-1 tools | **2 read-only**: `get_user_profile`, `get_workspace_info` |
| 6 | Lock-in mitigation | All app logic behind a thin `AgentRuntime` port; Agent SDK is one adapter |

### Accepted trade-offs (flagged, not blockers)
- **Subprocess per turn.** Agent SDK spawns a Claude Code subprocess per
  `query()`. At Phase-1 scale (a handful of concurrent turns) this is fine.
  Mitigations for later: concurrency cap (existing rate-limit guard), and
  extracting the runtime into a dedicated worker (existing BullMQ infra).
- **Max-plan auth does not scale to production multi-tenant** (per-account rate
  limits + usage-policy). Fine for dev/MVP; production will switch to
  `ANTHROPIC_API_KEY`. The auth switch (Decision #6) makes this a config flip.

## 3. Architecture

```
src/maestro/
├── maestro.module.ts                 # wires everything; imports UsersModule, WorkspaceModule, (existing) chatbot persistence
├── maestro.controller.ts             # POST /maestro/conversations/:id/messages  (SSE)
├── dto/
│   └── send-message.dto.ts
├── runtime/
│   ├── agent-runtime.interface.ts    # PORT: run(input) -> AsyncIterable<AgentEvent>
│   ├── claude-agent-sdk.runtime.ts    # ADAPTER over query(); maps SDK msgs -> AgentEvent
│   └── agent-event.ts                # normalized event union (surface-agnostic)
├── tools/
│   ├── agent-tool.interface.ts       # { name, description, schema(zod v4), handler(args, ctx) }
│   ├── tool-context.ts               # { userId, workspaceId }
│   ├── user.tools.ts                 # get_user_profile, get_workspace_info
│   └── build-mcp-server.ts           # createSdkMcpServer() from tools, closing over ctx
├── prompt/
│   ├── system-prompt.ts              # static product knowledge + SYSTEM_PROMPT_DYNAMIC_BOUNDARY
│   └── context-builder.ts            # per-request identity block (user/workspace/channels)
├── auth/
│   └── agent-auth.ts                 # resolve env -> { mode: 'oauth' | 'apiKey', env }
└── services/
    └── maestro.service.ts            # orchestrates: load history -> run runtime -> persist -> map to SSE
```

### 3.1 The `AgentRuntime` port (lock-in mitigation)

```ts
export interface AgentRunInput {
  ctx: ToolContext;                 // { userId, workspaceId }
  systemPrompt: string | string[];  // static + dynamic
  history: ConversationTurn[];      // replayed from our DB
  userMessage: string;
  signal: AbortSignal;
}

export interface AgentRuntime {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
```

`AgentEvent` is the **normalized** union the orchestrator consumes — independent
of the Agent SDK. The SDK adapter translates SDK messages into it; a future
Messages-API adapter could produce the same events.

```ts
export type AgentEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { type: 'error'; message: string };
```

### 3.2 Claude Agent SDK adapter (`claude-agent-sdk.runtime.ts`)

Verified against installed types (`@anthropic-ai/claude-agent-sdk` v0.3.178):

- Entry: `query({ prompt, options }): Query`, `prompt` as `AsyncIterable<SDKUserMessage>`.
- `options.tools = []` → **disables all built-in FS/Bash/Edit/Web tools** (the
  safe SaaS config; no deny-list guessing).
- `options.mcpServers = { maestro: <createSdkMcpServer(...)> }` → our 2 tools,
  exposed to the model as `mcp__maestro__get_user_profile` etc.
- `options.allowedTools = ['mcp__maestro__get_user_profile', 'mcp__maestro__get_workspace_info']`
  → auto-allow our tools (no permission prompt). `options.canUseTool` denies
  anything else as defense-in-depth.
- `options.includePartialMessages = true` → token + thinking deltas.
- `options.systemPrompt` = static product knowledge + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
  + dynamic identity (cacheable static prefix).
- `options.model` = `claude-sonnet-4-6` default (chat cost/latency); switchable.
- Thinking config set so deltas are non-empty (display `summarized`), since on
  Opus 4.x thinking text is omitted by default.
- `options.abortController` wired to the SSE client-disconnect signal.

**SDK message → `AgentEvent` mapping** (verified shapes):

| SDK message | → AgentEvent |
|---|---|
| `stream_event` · `content_block_delta` · `text_delta` | `text_delta` |
| `stream_event` · `content_block_delta` · `thinking_delta` | `thinking_delta` |
| `assistant` · block `tool_use` | `tool_call` |
| `user` · block `tool_result` | `tool_result` |
| `result` (`subtype: success`) | `done` (+ usage/cost) |
| `result` (`subtype: error`) / thrown | `error` |
| `system` · `init` | (capture `session_id`, ignore otherwise) |

### 3.3 Tools (`user.tools.ts`)

Surface-agnostic definition; the build step wraps each as an SDK `tool()`:

```ts
tool(
  'get_user_profile',
  'Get the current user's name, email, role, created date.',
  {} /* zod v4 raw shape: no params */,
  async (_args, _extra) => ({ content: [{ type: 'text', text: JSON.stringify(await usersService.findOne(ctx.userId)) }] }),
)
```

- Reuse `UsersService.findOne` and `WorkspaceService.findOne` (already exist;
  the current chatbot `user.tools.ts` calls the same).
- Context (`ctx`) is captured per-request by the factory `build-mcp-server.ts`,
  never global — each turn builds a fresh MCP server bound to that user.

### 3.4 Persistence (stateless DB-replay)

- **Source of truth = existing chatbot conversation tables** (reuse
  `ConversationService` / `chatbot.schema`). No new tables in Phase 1.
- Per turn: load conversation history from DB → pass as `history` in
  `AgentRunInput` → adapter replays it into the `query()` prompt (prior turns as
  prior user/assistant context) → persist the new user + assistant messages.
- **No SDK session files** (they'd break on Railway's ephemeral/multi-replica
  FS). If structured multi-turn fidelity is later needed, swap to a DB-backed
  `SessionStore` behind the same adapter — no controller/UI change.
- `cwd` for the subprocess set to an explicit writable temp dir; we never rely
  on it for state.

### 3.5 Auth switch (`agent-auth.ts`)

```
if (process.env.ANTHROPIC_API_KEY)  -> mode 'apiKey'  (production)
else (Claude Code OAuth creds present) -> mode 'oauth' (dev, Max plan)
```

- Resolves the `options.env` passed to the subprocess. `options.env` REPLACES
  the subprocess env, so we spread `process.env` and set the chosen auth.
- Dev: rely on the machine's logged-in Claude Code credentials (Max plan).
- Prod: `ANTHROPIC_API_KEY`. Exact OAuth-credential provisioning on a server is
  verified during implementation (smoke test).

### 3.6 Controller & SSE

- `POST /maestro/conversations/:id/messages` (JwtAuthGuard + rate-limit guard),
  mirrors the existing chatbot SSE controller pattern.
- Maps `AgentEvent` → the SSE event names the existing Maestro UI already
  consumes: `thinking_step`, `tool_executing`, `tool_complete`,
  `message_stream`, `message_complete`, `done`, `error`.
- `res.on('close')` → abort the runtime (kills the subprocess; stops billing).

## 4. Integration Risks (verify early)

1. **ESM-only package in a CommonJS NestJS build.** The SDK is `"type":
   "module"` (`sdk.mjs`). NestJS compiles to CommonJS; a static `import` will
   fail. Use a dynamic `await import('@anthropic-ai/claude-agent-sdk')` inside
   the adapter (or set module interop). **This is the #1 risk — smoke-test
   first.**
2. **zod v4 peer dep.** SDK requires `zod@^4`; the app may use zod v3 elsewhere.
   Import `zod/v4` only inside the tool definitions to avoid collision.
3. **Native binary present at runtime.** SDK pulls a platform binary via
   `optionalDependencies` (linux-x64/musl for Railway). Confirm it installs in
   the deploy image.
4. **Subprocess auth in a container** (OAuth credential file vs API key).
5. **`@anthropic-ai/sdk` peer `>=0.93.0`** — backend currently has 0.74; the
   Agent SDK install may require bumping it. Check for breakage in existing
   `claude.provider.ts`.

## 5. Build Order (smoke-test-driven)

1. Install SDK on the backend; write a **standalone smoke script** (1 file) that
   runs `query()` with `tools:[]` + one in-process tool, streams to stdout.
   Proves: ESM import works, auth works (Max plan), tool call + stream work.
2. Port the smoke script into the `AgentRuntime` adapter + event mapping.
3. Build the 2 tools + per-request MCP server factory.
4. System prompt + context builder.
5. `MaestroService` orchestration (history replay + persist) + controller (SSE).
6. Wire to existing persistence; verify `npm run build` green.
7. (Later, separate approval) Frontend: point the Maestro panel at
   `/maestro/...` — backend-first rule; ask before frontend.

## 6. Definition of Done (Phase 1)

- `npm run build` green in `socialmedia-workspace`.
- A manual call to `POST /maestro/conversations/:id/messages` streams: thinking
  → a `get_user_profile`/`get_workspace_info` tool call + result → final text →
  done, over SSE.
- Built-in FS/Bash tools provably unavailable (a test asserts a `Bash` request
  is denied).
- Auth runs on the Max plan locally with **no `ANTHROPIC_API_KEY`** set.
- Existing `ChatbotModule` unaffected.
```
