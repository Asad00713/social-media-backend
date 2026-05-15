# AI Assistant Architecture Document

## Overview

A full-featured AI assistant (add-on feature, not included in base plan) that can perform **every action a user can** within the system. It acts as an AI co-pilot for the social media management platform.

> **Important**: This is a **separate module** from the existing `src/ai/` module. The existing AI module handles content generation, drip campaigns, etc. This assistant is a standalone add-on feature with its own billing.

---

## Core Capabilities

1. **Read** — Query any data (posts, schedules, user profile, analytics, channels)
2. **Write** — Create posts, schedule content, edit drafts, manage campaigns
3. **Navigate** — Control the frontend UI (change pages, open modals, switch theme)
4. **Reason** — Understand context, pick the right action, chain multiple steps
5. **Remember** — Persist conversation history across sessions
6. **Voice** — Accept voice input via ElevenLabs STT (Phase 2)

---

## Technical Decisions

### Streaming: SSE (Server-Sent Events)

- Industry standard for LLM streaming (OpenAI, Anthropic, Google all use SSE)
- Unidirectional (server -> client) — exactly what chat streaming needs
- Works over standard HTTP — better for proxies, load balancers, CDN, scaling
- Built-in browser reconnection
- Existing Socket.IO stays untouched for notifications (separation of concerns)

### LLM Strategy: Provider-Agnostic Architecture

```
                    LLM Router
                        |
        +---------------+---------------+
        |               |               |
   Groq Provider   Gemini Provider   (Future)
   |-- Llama 3.3 70B   |-- Gemini Flash  |-- Claude
   +-- Llama 3.1 8B    +-- Gemini Pro    |-- GPT-5
                                         +-- Others
```

- **v1 starts with Groq** (Llama 3.3 70B for reasoning + tool calls, Llama 3.1 8B for simple Q&A)
- Abstract `LLMProvider` interface — adding a new provider = just implementing one class
- Model router decides which provider/model based on task complexity
- Adding paid models later is just registering a new provider

### Follow-up Suggestions: Included from Day 1

LLM generates contextual follow-up suggestions after every response.

---

## Module Structure

```
src/chatbot/
|-- chatbot.module.ts
|-- chatbot.controller.ts            <-- SSE endpoint + conversation CRUD
|-- chatbot.service.ts               <-- Core orchestration
|
|-- services/
|   |-- agent.service.ts             <-- Agent loop (LLM -> tools -> loop)
|   |-- conversation.service.ts      <-- Persistence (save/load chats)
|   |-- context-builder.service.ts   <-- Inject user/workspace context
|   |-- followup.service.ts          <-- Generate follow-up suggestions
|   +-- stream.service.ts            <-- SSE event management
|
|-- llm/
|   |-- llm-provider.interface.ts    <-- Abstract interface
|   |-- groq.provider.ts            <-- Groq (Llama models)
|   +-- llm-router.service.ts       <-- Model selection logic
|
|-- tools/
|   |-- tool.interface.ts            <-- Tool definition contract
|   |-- tool-registry.service.ts     <-- Register & manage all tools
|   |-- user.tools.ts                <-- "What's my name?", profile info
|   |-- post.tools.ts                <-- Create, edit, delete, list posts
|   |-- scheduling.tools.ts          <-- Schedule posts, list upcoming
|   |-- channel.tools.ts             <-- Connected channels, platform info
|   |-- workspace.tools.ts           <-- Workspace settings, members
|   |-- navigation.tools.ts          <-- Navigate, change theme, UI actions
|   +-- analytics.tools.ts           <-- Post counts, performance data
|
|-- dto/
|   |-- send-message.dto.ts
|   +-- conversation.dto.ts
|
+-- schemas/
    +-- chatbot.schema.ts            <-- conversations + messages tables
```

---

## Agent Loop (Core Engine)

```
User sends message
       |
       v
+-- Context Builder ------------------------+
| Inject: user profile, workspace,          |
| connected channels, current page,         |
| conversation history                      |
+-------------------+-----------------------+
                    |
       v SSE: { type: "thinking_start" }
                    |
+-- Agent Loop -----+------------------------+
|                                            |
|  1. Send to LLM (with tools schema)       |
|          |                                 |
|  2. LLM responds:                          |
|     |-- Text? -> Stream to client          |
|     +-- Tool call? v                       |
|                                            |
|  3. SSE: { step: "Looking up posts..." }   |
|     Execute tool (call your service)       |
|     Feed result back to LLM               |
|          |                                 |
|  4. Loop back to step 1                    |
|     (until LLM gives final text)           |
|                                            |
+-------------------+------------------------+
                    |
       v SSE: { type: "message_stream", ... }
       v SSE: { type: "followups", ... }
       v SSE: { type: "actions", ... }
                    |
       Save to DB (conversation + messages)
```

---

## Database Schema

### conversations

| Column       | Type      | Description                    |
|-------------|-----------|--------------------------------|
| id          | uuid (PK) | Primary key                    |
| user_id     | uuid (FK) | References users table         |
| workspace_id| uuid (FK) | References workspace table     |
| title       | text      | Auto-generated from first msg  |
| created_at  | timestamp | Creation timestamp             |
| updated_at  | timestamp | Last update timestamp          |

### chat_messages

| Column          | Type       | Description                              |
|----------------|------------|------------------------------------------|
| id             | uuid (PK)  | Primary key                              |
| conversation_id| uuid (FK)  | References conversations table           |
| role           | enum       | user / assistant / system / tool         |
| content        | text       | The message content                      |
| metadata       | jsonb      | Tool calls, thinking steps, follow-ups   |
| model_used     | text       | Which LLM handled this message           |
| token_count    | integer    | Token usage for billing/tracking         |
| created_at     | timestamp  | Creation timestamp                       |

---

## API Endpoints

```
POST   /chatbot/conversations                    <-- Start new conversation
GET    /chatbot/conversations                    <-- List user's conversations
GET    /chatbot/conversations/:id                <-- Get conversation + messages
DELETE /chatbot/conversations/:id                <-- Delete conversation

POST   /chatbot/conversations/:id/messages       <-- Send message (returns SSE stream)
GET    /chatbot/conversations/:id/messages       <-- Get message history (pagination)
```

---

## SSE Event Types (Frontend Contract)

```typescript
// What the frontend receives:
{ event: "thinking_start" }
{ event: "thinking_step",  data: { step: "Looking up your scheduled posts..." } }
{ event: "tool_executing", data: { tool: "get_scheduled_posts", params: {...} } }
{ event: "tool_complete",  data: { tool: "get_scheduled_posts" } }
{ event: "message_stream", data: { token: "You have" } }
{ event: "message_stream", data: { token: " 5 posts" } }
{ event: "message_stream", data: { token: " scheduled for tomorrow." } }
{ event: "followups",      data: { suggestions: ["Show me the posts", "Reschedule them all"] } }
{ event: "actions",        data: { actions: [{ type: "navigate", route: "/posts/scheduled" }] } }
{ event: "done" }
```

---

## Multi-Model Router Logic

```
User message -> Intent Classifier (fast model)
    |-- Simple Q&A          -> Groq Llama 3.1 8B (fast, cheap)
    |-- Complex reasoning   -> Groq Llama 3.3 70B (capable)
    |-- Tool-calling tasks  -> Groq Llama 3.3 70B (tool support)
    |-- UI navigation       -> Pattern match (no LLM needed)
    +-- Multi-step tasks    -> Capable model with agent loop
```

Future paid models (Claude, GPT-5, etc.) slot into the router as premium options.

---

## Security & Guardrails

1. **Destructive action confirmation** — Delete, publish now, disconnect channel require user confirmation before execution
2. **Scope isolation** — AI can only access data within the user's workspace
3. **Prompt injection protection** — Sanitize user input, validate tool outputs
4. **Rate limiting** — Per-user request limits to prevent abuse
5. **Token budget** — Track and enforce AI token usage per workspace (add-on billing)
6. **Audit logging** — Log all tool executions for accountability

---

## Response Format Optimization

The AI adapts response format based on user intent:

| User Intent                    | Response Style                      |
|-------------------------------|-------------------------------------|
| "What's my name?"             | Short, direct answer                |
| "How do I create a post?"     | Numbered step-by-step instructions  |
| "Schedule a post for tomorrow"| Execute + confirm with details      |
| "How many posts this week?"   | Data summary with counts            |
| "Navigate to calendar"        | Minimal text + UI action payload    |

---

## Billing Model

This assistant is a **paid add-on**, separate from the base subscription plan:

- Not included in any base plan
- Billed per workspace as an add-on
- Token usage tracked and enforced
- Different tiers possible (basic AI with free models, premium AI with Claude/GPT-5)
