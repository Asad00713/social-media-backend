# Maestro Bridge — Telegram Rich Rendering (Plan B)

**Goal:** Make the Telegram bridge fully usable — confirm/`ask_user` questions render as **tappable inline keyboard buttons** (so outward actions can actually be confirmed from Telegram), media tool-results show as image previews, and `/switch` changes the active workspace.

**Architecture:** `runHeadlessTurn` now returns `{ text, question?, media? }` (captured from `tool_result` events). The processor renders the question as an inline keyboard and stores the pending option set on the link; a `callback_query` tap feeds the chosen option back as the next turn (the model re-calls the tool with `confirmed:true` / the answer), exactly mirroring the in-app card-answer flow.

## Global Constraints
- Backend `socialmedia-workspace/`, `npm run build` green per task.
- v1 limits (noted, acceptable): single-select only (one tap = one option); multi-question `ask_user` renders only the FIRST question's buttons; media shown as URL previews (not re-uploaded photos).
- Confirm gate stays a tool-level two-phase mechanism — no per-tool special-casing.

### Task B1: `runHeadlessTurn` returns text + question + media
- Modify `src/maestro/services/maestro.service.ts`: export `HeadlessTurnResult` (`{ text: string; question?: { questions: {header,question,options,multiSelect}[] }; media?: {url,title?}[] }`); in the consume loop, on `tool_result` parse `output` via `parseToolPayload`; `kind:'question'` → normalize questions; `kind:'media'` → collect `items[].url`. Return all three.

### Task B2: pending-state CRUD on `BridgeLinkService`
- `setConversation(linkId, conversationId: string | null)` (accept null to reset on workspace switch).
- `setPending(linkId, pending: { kind: 'question'|'workspace'; items: string[]; labels: string[] } | null)` → store under `metadata.pending`.

### Task B3: processor — inline buttons + callback resume
- Extract `runAndReply(chatId, link, message)`: ensure conversation, `runHeadlessTurn`, send `text`, send each `media.url` (preview), and if `question` → store pending (kind question, items+labels = options) + `sendMessage` with `inline_keyboard` (one button per option, `callback_data='p:<i>'`).
- `handleMessage` calls `runAndReply`.
- Add `callback_query` handling in `process`: `answerCallbackQuery`, resolve link by `from.id`, read `metadata.pending`, act on `items[index]`: question → `runAndReply(message=item)` (may produce another question); clear pending after.

### Task B4: `/switch` workspace
- In `handleMessage`, `/switch` → `WorkspaceService.findAllByUser`, store pending (kind workspace, items=ids, labels=names), send buttons.
- callback workspace → `setDefaultWorkspace(items[i])` + `setConversation(null)` (fresh conversation in new workspace) + clear pending + confirm "✅ Switched to <label>".

## Follow-up
- Plan D — Connect Maestro UI (frontend). Plan C (WhatsApp + notifications) — deferred by user.
