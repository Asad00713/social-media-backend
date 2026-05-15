# AI Assistant - Development TODO

> Status: Phase 1 Complete | Next: Phase 2 (Starter Tools)
> Branch: 26-create-basic-chatbot

---

## Phase 1: Foundation (Core Infrastructure) ✅ COMPLETE

- [x] Create `src/chatbot/` module structure
- [x] Define database schema (`conversations`, `chat_messages` tables) → `src/drizzle/schema/chatbot.schema.ts`
- [x] Push database schema (via `drizzle-kit push --force`)
- [x] Create `BaseLLMProvider` abstract interface → `src/chatbot/llm/llm-provider.interface.ts`
- [x] Implement Groq provider (Llama 3.3 70B + 3.1 8B) → `src/chatbot/llm/groq.provider.ts`
- [x] Create LLM Router service → `src/chatbot/llm/llm-router.service.ts`
- [x] Create tool definition interface → `src/chatbot/tools/tool.interface.ts`
- [x] Build `ToolRegistry` service → `src/chatbot/tools/tool-registry.service.ts`
- [x] Implement core Agent Loop (streaming + tool execution loop) → `src/chatbot/services/agent.service.ts`
- [x] Build context builder service (injects user/workspace/channels) → `src/chatbot/services/context-builder.service.ts`
- [x] Create conversation service (CRUD + persistence) → `src/chatbot/services/conversation.service.ts`
- [x] Create chatbot orchestrator service → `src/chatbot/chatbot.service.ts`
- [x] Set up chatbot controller with SSE endpoint → `src/chatbot/chatbot.controller.ts`
- [x] Create DTOs and validation → `src/chatbot/dto/`
- [x] Create chatbot module → `src/chatbot/chatbot.module.ts`
- [x] Register in `app.module.ts` and schema `index.ts`
- [x] Build compiles clean (0 errors)

### Phase 1 File Map
```
src/chatbot/
├── chatbot.module.ts              ← NestJS module
├── chatbot.controller.ts          ← REST + SSE streaming endpoints
├── chatbot.service.ts             ← Main orchestrator
├── services/
│   ├── agent.service.ts           ← Core agent loop (LLM → tools → loop)
│   ├── conversation.service.ts    ← Conversation CRUD + persistence
│   └── context-builder.service.ts ← System prompt with live data
├── llm/
│   ├── llm-provider.interface.ts  ← Abstract LLM provider contract
│   ├── groq.provider.ts           ← Groq implementation (streaming + tool calls)
│   └── llm-router.service.ts      ← Model selection router
├── tools/
│   ├── tool.interface.ts          ← ChatbotTool interface
│   └── tool-registry.service.ts   ← Tool registration + execution
└── dto/
    ├── send-message.dto.ts        ← Message input
    └── conversation.dto.ts        ← Conversation CRUD DTOs
```

### Phase 1 API Endpoints
```
POST   /chatbot/conversations              → Create conversation
GET    /chatbot/conversations              → List conversations (?workspaceId=)
GET    /chatbot/conversations/:id          → Get conversation + messages
DELETE /chatbot/conversations/:id          → Delete conversation
GET    /chatbot/conversations/:id/messages → Get messages (paginated)
POST   /chatbot/conversations/:id/messages → Send message (SSE stream response)
```

---

## Phase 2: Starter Tools ⬅️ NEXT

> **IMPORTANT**: The assistant currently has ZERO tools registered. Without tools, it can chat but CANNOT perform any actions in the system. These tools are what connect the AI to the actual services.

> Each tool file: defines tool(s), injects the relevant service via DRIZZLE, and is registered in `chatbot.module.ts`.

### Priority tools (needed for first test):
- [ ] `user.tools.ts` — Get user profile (name, email, role), workspace members list
- [ ] `post.tools.ts` — Create post, list posts, get post by ID, update post, delete post, list scheduled posts (with date/platform filters)
- [ ] `channel.tools.ts` — List connected channels, get channel details
- [ ] `navigation.tools.ts` — Navigate to page, change theme (returns UI action payloads)

### Secondary tools:
- [ ] `workspace.tools.ts` — Workspace info, members, settings
- [ ] `scheduling.tools.ts` — Schedule posts, list upcoming, reschedule, cancel scheduled
- [ ] `analytics.tools.ts` — Post counts by status/platform/date, publishing stats
- [ ] `web-search.tools.ts` — Live web search via Tavily (for questions outside the system)

### Wiring:
- [ ] Register all tools in `chatbot.module.ts` (inject as providers, register in ToolRegistry on module init)
- [ ] Import necessary modules (PostsModule, ChannelsModule, UsersModule, etc.) in ChatbotModule

---

## Phase 3: Smart Features

- [ ] Follow-up suggestion generator (already scaffolded in agent.service.ts — needs tuning)
- [ ] Multi-model router with intent classification
- [ ] Response format optimization (adaptive formatting based on intent)
- [ ] Confirmation flow for destructive actions (delete/disconnect)
- [ ] Thinking steps streaming (already emitting events — needs frontend to render)

---

## Phase 4: Security & Guardrails

- [ ] Prompt injection protection (input sanitization)
- [ ] Workspace scope isolation (AI can only access user's workspace data)
- [ ] Rate limiting per user (requests per minute)
- [ ] Token usage tracking and enforcement (integrate with existing AiTokenService)
- [ ] Audit logging for all tool executions
- [ ] Destructive action confirmation system (AI asks user before delete/publish)

---

## Phase 5: Billing Integration

- [ ] Add AI assistant as add-on in billing system
- [ ] Token usage metering per workspace
- [ ] Usage limits enforcement
- [ ] Add-on subscription management
- [ ] Usage dashboard data for billing

---

## Phase 6: Voice Integration

- [ ] Voice input endpoint (audio upload → ElevenLabs STT → text)
- [ ] Integrate STT output into chat pipeline
- [ ] (Optional) TTS response output with ElevenLabs
- [ ] Voice activity detection / streaming audio input

---

## Phase 7: Additional LLM Providers

- [ ] Gemini provider (Gemini Flash + Gemini Pro)
- [ ] OpenAI provider (GPT-5 — paid tier)
- [ ] Anthropic provider (Claude — paid tier)
- [ ] Model preference per workspace/user setting
- [ ] Premium model access gating (paid add-on tiers)

---

## Phase 8: Advanced Features

- [ ] Multi-step task chaining (complex workflows)
- [ ] Proactive suggestions (AI notices patterns and suggests actions)
- [ ] Conversation search and history browsing
- [ ] Conversation sharing within workspace
- [ ] AI-generated conversation titles (via LLM call instead of truncation)
- [ ] Pinned/favorite conversations
- [ ] Export conversation history

---

## Notes

- This is a **separate module** from `src/ai/` (existing AI content generation)
- This is a **paid add-on**, not included in base subscription plans
- Start with free models (Groq/Llama), add paid models later
- Voice integration deferred to Phase 6
- Web search uses existing Tavily integration (already in project)
- Frontend contract (SSE events) defined in `docs/ai-assistant-architecture.md`
- Import pattern: use `import type { DbType }` (not `import { DbType }`) for Drizzle DB type
