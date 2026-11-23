# Maestro post composing — preview card + create / schedule / publish

Status: **PLAN — awaiting approval.** No code written yet.
Date: 2026-11-23. Supersedes the first (text-only) draft after the user's
"preview card + channel tabs, user decides Save/Schedule/Publish" direction.

## The vision (user's words, 2026-11-23)

Maestro should compose a post the way the Figma composer does: image chosen,
caption written, and then a **post-preview card rendered inside the Maestro
panel** — with **channel tabs** when several channels are targeted (one preview
per channel). The user decides on the card:

- **"Save"** → save as a draft **directly, no confirm** (reversible).
- **"Schedule"** → **confirm**, then schedule for the chosen time.
- **"Publish"** → **confirm**, then publish now.

Per-tool permission toggles (save / schedule / publish / message / comment on–off
in settings) are a **separate, later effort** — not this plan. This plan keeps
the existing confirm-gate behaviour (publish/schedule confirm; save doesn't).

## Why this is smaller than it looks

The preview UI already exists and is reusable (composition, not re-creation):

- `socialmedia-frontend-maestro/src/features/planner/components/post-dialog/post-preview.tsx`
  — `PostPreview` draws exactly the card the user described: a **channel-tab row**
  (platform icons, selectable) above a **single preview card** (avatar, handle,
  media, caption) for the selected channel. Figma `4513:2217`. It takes a
  `PlannerPost`, a `Map<number, Channel>`, a selected channel id, and an
  `onSelectChannel` callback.
- Per-platform preview cards also exist under
  `src/features/composer/components/previews/` (threads, pinterest, youtube,
  facebook-carousel, …) if we later want platform-accurate previews.

So the Maestro card = a wrapper around (or a close adaptation of) `PostPreview`
plus a Save / Schedule / Publish action row. No mini-composer from scratch.

## Backend (verified against code, 2026-11-23)

- `PostService.createPost(workspaceId, userId, dto, role?)`
  (`src/posts/services/post.service.ts:151`) does BOTH jobs: no `scheduledAt` →
  `draft`; with `scheduledAt` → `scheduled` (queue-limit `enforceQueueLimit`,
  past-date `assertNotInPast`, `schedulePublishJob`). Viewer role refused for
  scheduling. Channels validated against the workspace.
- `PostService.publishPost(...)` already wrapped by Maestro's `publish_post`.
- `CreatePostDto` (`src/posts/dto/post.dto.ts`): `content?`, `mediaItems?`
  (`MediaItemDto[]`), `targetChannelIds` (number-strings), `scheduledAt?` (ISO),
  `platformContent?`, `metadata?`.
- Channel ids: `list_channels` tool (`channel.tools.ts:183`) returns
  `{ id: String(ch.id), platform }`; the model resolves "Instagram" → id(s).
- Confirm gate: `confirm.ts` `isConfirmed` / `confirmCard`; every outward tool
  takes optional `confirmed`.
- Reference chips: `postReference(post)` in `post.tools.ts`.

### Tools (two, per the user's choice)

Both added to `createPostTools(...)` in `src/maestro/tools/post.tools.ts`.

1. **`create_post`** — makes a **draft**. Input: `content`, `channelIds[]`,
   `mediaUrls?[]`, `confirmed?` (unused for the no-confirm save path, but kept
   for symmetry / future permission gate). **No confirm gate** (draft is
   reversible — the user's "save directly"). Returns a result the FRONTEND turns
   into the **preview card** (see below), plus a `postReference` chip once saved.
2. **`schedule_post`** — creates a **scheduled** post. Input: `content`,
   `channelIds[]`, `scheduledAt` (future ISO), `mediaUrls?[]`, `confirmed?`.
   **Confirm gate ON** (outward). On confirm → `createPost` with `scheduledAt`.

`publish_post` already exists (confirm-gated) for the "Publish now" button's
underlying action.

Media v1: **image URLs only** (`mediaUrls` → `mediaItems` with `type:'image'`);
video / alt-text / dimensions deferred (user approved image-only v1).

### The preview-card contract (the key new piece)

The user wants the card to appear **before** the post is committed, so the model
proposes a post and the user commits it. Two shapes to decide between (open
question 1 below):

- **(A) Propose-then-commit:** `create_post` / `schedule_post` with `confirmed`
  unset returns a **`post_preview` result** (content + channelIds + media +
  intended action) that the frontend renders as the interactive card. The card's
  Save / Schedule / Publish buttons then call back — Save commits a draft (no
  confirm), Schedule/Publish go through the confirm card. This matches "user
  decides on the card".
- **(B) Commit-then-show:** the tool creates the draft immediately and returns a
  `postReference`; the card is just a rich render of the saved draft with
  action buttons to schedule/publish it.

**Recommend (A)** — it matches the user's flow (the card is where the user
decides save vs schedule vs publish; nothing is written until they click). It
needs a new result `kind:'post_preview'` the frontend recognises, and a small
amount of client state to turn the card's buttons into the right follow-up /
tool call. (B) is simpler but commits a draft the user may not want.

## Frontend

- **New component** `src/features/maestro/components/post-preview-card.tsx` —
  wraps/adapts `PostPreview` (channel tabs + per-channel preview) and adds a
  Save / Schedule / Publish action row (shadcn `Button`, Hugeicons, theme
  tokens). Schedule opens a time picker (reuse the composer's scheduler if one is
  exported; else a shadcn date-time popover). Save = commit draft (no confirm);
  Schedule / Publish = go through Maestro's existing confirm card.
- **Wire it in `agent-message.tsx`** the way `MediaGrid` / `QuestionCard` are
  wired: when an assistant message carries a `post_preview` block, render the
  card; its buttons call `onPickFollowup(...)` or a new typed callback that
  issues the commit (mirroring how `MediaGrid`'s "Use in a post" sends a
  follow-up). Keep to "screen, not spec" — buttons drive Maestro, no direct
  post/library wiring beyond `createPost`.
- Types: extend the Maestro message content union with a `post_preview` block
  (`use-maestro-chat.ts` normaliser + `types/maestro.ts`), the same pattern the
  media grid / question card use.

## Safety / constraints (hard rules)

- **NO DB schema / NO migration** — `createPost` already writes everything.
- **No `db:push`.**
- Confirm gate stays a HARD gate for schedule/publish; save is deliberately
  gate-free (reversible), per the user.
- Pass caller **role** to `createPost` (server refuses viewer scheduling —
  defence in depth).
- Register + capability-gate the new tools in `assemble.ts` +
  `capability-gate.ts` like the other post tools (verify before building).
- **Prod-data discipline:** local backend + TEST drafts only. A scheduled test
  post gets a far-future time and is DELETED before it can fire. Never let a test
  actually publish.

## Testing

- Unit `post.tools.spec.ts` (mirror `publish_post` tests): create_post makes a
  draft; schedule_post confirm-gates and refuses a past time with a friendly
  message; viewer refused; bad channel id → `ok:false`, not a throw.
- Frontend vitest for `post-preview-card` (channel-tab switch, button-enabled
  states, Save vs Schedule vs Publish intent).
- Local live: ask Maestro to draft a post → preview card with channel tabs →
  Save (draft appears in Planner) / Schedule (confirm → scheduled, far-future,
  then delete) / Publish (confirm — only on a throwaway channel, or verify the
  confirm card and stop short of actually posting).

## Build order (once approved)

1. Backend: `create_post` + `schedule_post` tools + `post.tools.spec.ts`;
   register/gate; `npm run build` + spec green.
2. Define the `post_preview` result shape + the Maestro message block type.
3. Frontend `post-preview-card.tsx` (adapt `PostPreview` + action row) + wiring
   in `agent-message.tsx` + normaliser; vitest.
4. Local live smoke test end-to-end; delete test posts.

## Open questions (need the user before building)

1. **Propose-then-commit (A) vs commit-then-show (B)** — recommend (A). Confirm.
2. **Schedule time picker** — reuse a composer/planner scheduler component if one
   is exported, or a plain shadcn date-time popover? (I'll check what's
   reusable; flagging in case there's a preferred one.)
3. **Publish from the card** — "Publish now" on the card posts publicly. Confirm
   the card's Publish uses the SAME confirm card as the tool (yes recommended).
4. **Platform-accurate previews** — v1 can use the generic `PostPreview` card
   (one layout, per-channel content). Richer per-platform previews
   (`composer/previews/*`) are a later polish. Confirm generic is fine for v1.

## Out of scope (separate efforts)

- **Per-tool permission toggles** (save/schedule/publish/message/comment on–off
  in settings) — the user's own "baad mein, alag effort".
- **C4 check-in** (stored, reschedulable future turn) — absent from both repos.
- **Row C multi-draft result card** (five drafts at once) — once single-post
  tools + the preview card land, the five-draft card is a follow-on.
- **Row E resume/Continue** — planned separately (see
  `docs/maestro/row-e-continue-plan.md`).
