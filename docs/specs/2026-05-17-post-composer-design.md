# Post Composer — Design Spec

**Date:** 2026-05-17
**Status:** Draft — awaiting user approval
**Scope:** Full-page multi-channel post composer + supporting backend infrastructure
**Estimated effort:** 6–8 weeks for v1 (single-platform foundation + 4 priority platforms)

---

## 1. Goal & Non-Goals

### Goal
Build a production-grade post composer that lets users:
1. Compose once, publish to multiple connected channels across all 10 platforms
2. Override per-platform content where needed, with explicit visual clarity (no Buffer-style silent merging)
3. Handle each platform's actual constraints (media formats, char limits, required fields, scheduling)
4. See live per-platform preview before publishing
5. Schedule, save as draft, or publish now
6. Recover gracefully from per-platform publish failures (retry/skip/edit)

### Non-Goals (v1)
- **Mobile responsive layout** — desktop-first; mobile is Phase 2
- **Plugin architecture** for polls/products/carousels — YAGNI, build core first
- **Cross-platform auto-adaptation** ("long LinkedIn post → Twitter thread automatically") — Phase 2 AI feature
- **Time-travel version history** — auto-save is sufficient; full history is Phase 2
- **Quick-Post modal escape hatch** — single full-page composer only (per user decision)
- **Bulk CSV upload** — separate feature for Phase 3
- **Approval workflows** — comes with agent runtime (separate roadmap item)
- **A/B testing variants** — Phase 3
- **Collaborative editing** (Google Docs-style multi-user) — Phase 3

---

## 2. Architecture — 6 Layers

Inspired by GPT's review insight that "Original + override" is fundamentally a data-model problem, not a UI problem. Each layer has a single clear responsibility and well-defined interface to the next.

| Layer | Responsibility | UI? |
|---|---|---|
| **L1: Compose Engine** | Pure data: master content + override resolution + normalization | No |
| **L2: Capability Registry** | Per-platform composer-capabilities config | No |
| **L3: Media Pipeline** | Validation + transformation + per-platform variants | No |
| **L4: Preview Renderers** | Per-platform Preview components reading normalized payload | Yes |
| **L5: Composer UI** | Tabs, panels, editor, AI assist | Yes |
| **L6: Publication Orchestrator** | Per-channel publish state machine, retry, partial-success | No |

This separation lets us build/test each independently. UI changes don't break the data layer. Adding a new platform = adding registry entry + adapter + preview renderer, no core changes.

---

## 3. L1: Compose Engine (Data Model)

### Master draft + per-platform overrides

The fundamental shape that solves the "Original ↔ tab" conflict resolution problem.

```ts
interface Draft {
  id: string                            // uuid
  workspaceId: string
  createdById: string
  status: DraftStatus                   // see state machine §10
  base: BaseContent                     // the "Original" master
  perPlatform: PlatformOverrides        // per-platform overrides (sparse)
  channels: ChannelTarget[]             // which channels to publish to
  schedule: ScheduleConfig
  createdAt: string
  updatedAt: string
}

interface BaseContent {
  text: string                          // body text
  mediaItems: MediaItem[]               // attached media (master copies)
  hashtags: string[]                    // separately tracked for platform-specific placement
  mentions: Array<{ handle: string; platform?: SupportedPlatform }>
  linkPreview?: { url: string; title?: string; description?: string }
}

interface PlatformOverrides {
  twitter?:   PlatformOverride<TwitterFields>
  instagram?: PlatformOverride<InstagramFields>
  youtube?:   PlatformOverride<YouTubeFields>
  facebook?:  PlatformOverride<FacebookFields>
  linkedin?:  PlatformOverride<LinkedInFields>
  tiktok?:    PlatformOverride<TikTokFields>
  pinterest?: PlatformOverride<PinterestFields>
  threads?:   PlatformOverride<ThreadsFields>
  bluesky?:   PlatformOverride<BlueskyFields>
  mastodon?:  PlatformOverride<MastodonFields>
}

interface PlatformOverride<TFields> {
  inheritsFromBase: boolean             // master toggle (default true)
  overrides: Partial<TFields>           // sparse — only fields explicitly customized
  platformSpecific: Partial<TFields>    // platform-only fields (e.g., YT title, IG type)
}
```

**Key principle: sparse overrides.** If `overrides.text` is missing, that platform's text inherits from `base.text`. If present, it's customized. This is the core mental model — each field is independently inheritable.

**Conflict resolution (the Claude #3 concern):** When user edits `base.text`, all platforms with no `overrides.text` automatically reflect the change. Platforms that did override stay overridden. Each tab shows a "Reset to Original" button that clears that platform's overrides.

### Channel targeting

```ts
interface ChannelTarget {
  channelId: number                     // social_media_channels.id
  platform: SupportedPlatform
  scheduleAt?: string                   // ISO — overrides draft.schedule if per-channel mode
  publishStatus: PublishStatus          // tracked AFTER publish initiated
  platformPostId?: string               // set after success
  platformPostUrl?: string
  errorMessage?: string
  attemptedAt?: string
  publishedAt?: string
}
```

Multiple channels CAN be selected for the same platform (e.g., 3 Twitter accounts in an agency). The UI groups them under one "Twitter (3)" tab; the data model treats each as a separate publish target.

### Normalization function

```ts
function resolvePublicationPayload(
  draft: Draft,
  channel: ChannelTarget,
): PublicationPayload {
  const override = draft.perPlatform[channel.platform]
  return {
    text: override?.overrides.text ?? draft.base.text,
    mediaItems: override?.overrides.mediaItems ?? draft.base.mediaItems,
    hashtags: override?.overrides.hashtags ?? draft.base.hashtags,
    // ...field-by-field resolution
    platformSpecific: override?.platformSpecific ?? {},
  }
}
```

This is THE function. Used by Preview Renderers (Layer 4), Publication Orchestrator (Layer 6), and AI rewrite pipeline. Single source of truth for "what will actually publish for this channel."

---

## 4. L2: Capability Registry (Extended)

We already have `PlatformCapabilities` for analytics. Extend it with a `composer` sub-object that drives composer UI rendering and validation.

```ts
interface ComposerCapabilities {
  // Content fields supported
  supportsTitle: boolean
  supportsBody: boolean
  supportsDescription: boolean          // long-form (YT description)
  supportsHashtags: boolean
  supportsFirstComment: boolean         // IG/LinkedIn pattern
  supportsThread: boolean               // Twitter / Bluesky / Mastodon
  supportsPoll: boolean                 // Twitter / Mastodon
  supportsLocation: boolean             // IG
  supportsMentions: boolean
  supportsLinkPreview: boolean

  // Platform-specific knobs
  postTypes: PostType[]                 // ['feed', 'reel', 'story'] for IG; ['video', 'short'] for YT
  visibilityOptions: VisibilityOption[] // ['public', 'unlisted', 'private'] for YT; ['everyone', 'connections'] for LinkedIn
  replyControlOptions: string[]         // Twitter / Threads / Bluesky

  // Character limits
  maxCharsTitle?: number
  maxCharsBody: number
  maxCharsDescription?: number
  maxCharsFirstComment?: number

  // Media constraints
  mediaConstraints: MediaConstraints

  // Validation
  requiredFields: Array<keyof BaseContent | string>
}

interface MediaConstraints {
  imageMaxCount: number
  imageMaxSizeMB: number
  imageAllowedTypes: string[]           // ['image/jpeg', 'image/png']
  imageAspectRatios: string[]           // ['1:1', '4:5', '16:9']

  videoMaxCount: number
  videoMaxSizeMB: number
  videoMaxDurationSec: number
  videoMinDurationSec?: number
  videoAllowedTypes: string[]
  videoAspectRatios: string[]

  carouselMaxCount?: number             // IG carousel
  requiresThumbnail?: boolean           // YT
  requiresMediaOfType?: 'video' | 'image' // TikTok requires video
}
```

This registry is the SINGLE source of truth for "what can this platform do." Composer UI reads it at render time. Validators read it. AI prompts can reference it.

**Adding a new platform = adding registry entry. Zero UI code changes.**

---

## 5. L3: Media Pipeline

### Validation (real-time, per-tab indicator)

When user uploads media, validate against EACH selected platform's `mediaConstraints`. Tab indicators:

```
[Twitter] 🟢
[Instagram] 🟡  (one warning: image too small)
[YouTube] 🔴   (error: requires video, only image uploaded)
[TikTok] 🔴    (error: video exceeds 10min)
```

Hover tooltip = full validation message.

### Auto-transformation suggestions

For common fixable issues, offer one-click transforms:
- **Aspect ratio mismatch** → "Crop to 9:16 for Instagram Reel" button (user reviews crop)
- **Image too large** → "Compress to under 5MB" (lossless if possible)
- **Video too long** → "Trim to first 90s for IG Reel" (with editor)
- **Missing thumbnail (YT)** → "Generate from video frame at 0:05" or upload

User opts in to each transformation. Original media stays untouched; transformed copies are stored as variants linked to the draft.

### Per-platform media variants

```ts
interface MediaItem {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string                           // original
  width?: number
  height?: number
  durationSec?: number
  sizeBytes: number
  variants?: Partial<Record<SupportedPlatform, MediaVariant>>
  altText?: string
}

interface MediaVariant {
  url: string                           // platform-adapted version (cropped/compressed/etc.)
  width: number
  height: number
  transformations: string[]             // ['crop:9:16', 'compress:80%']
}
```

At publish time, orchestrator uses variants[platform] if exists, else original. Variants are generated lazily (only when user opts into a transformation).

---

## 6. L4: Preview Renderers

One Preview component per platform, reading the normalized publication payload (NOT raw editor state — prevents drift).

```ts
interface PreviewProps {
  payload: PublicationPayload           // resolved via resolvePublicationPayload()
  channel: ChannelEntity                // for author avatar, handle, etc.
}

// Components:
<TwitterPreview />
<InstagramPreview />
<YouTubePreview />
<FacebookPreview />
<LinkedInPreview />
<TikTokPreview />
<PinterestPreview />
<ThreadsPreview />
<BlueskyPreview />
<MastodonPreview />
```

Each renders a platform-accurate mockup: correct typography, hashtag styling, image cropping, character truncation indicators ("... See more"), correct icons.

Registry lookup:
```ts
const PREVIEW_RENDERERS: Record<SupportedPlatform, ComponentType<PreviewProps>> = { ... }
```

Active tab → render that platform's preview. "Original" tab → show a stacked mini-preview of all selected platforms (or one selected by user).

---

## 7. L5: Composer UI

### Page route
`/w/<workspaceId>/compose` (new draft) and `/w/<workspaceId>/compose/<draftId>` (existing).

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back                          Draft auto-saved · 4s ago       │
├──────────────────────────────────────────────────────────────────┤
│  Channels: [X Twitter(2)] [X Instagram] [+ Add channel ▾]        │
├──────────────────────────────────────────────────────────────────┤
│  Tabs: [Original*]  [Twitter (2)]  [Instagram]  [YouTube ⚠️]     │
├────────────────────────────────────┬─────────────────────────────┤
│ EDITOR PANEL                        │ PREVIEW PANEL               │
│                                     │                             │
│  [TipTap editor]                    │  [Active tab's preview]     │
│                                     │                             │
│  Media: ┌──────────┐ ┌──────────┐  │  (platform-accurate mockup)│
│         │ image1   │ │ image2   │  │                             │
│         └──────────┘ └──────────┘  │                             │
│  Media validity: [IG🟢][YT🔴][Tw🟢] │                             │
│                                     │                             │
│  ─── Original tab: char counters ── │                             │
│  Twitter   [████░░] 210/280   ✅    │                             │
│  Instagram [██░░░░] 210/2200  ✅    │                             │
│  YouTube body [█░░░░] 210/5000 ✅   │                             │
│                                     │                             │
│  ─── Per-platform tab: settings ── │                             │
│  Inheriting from Original ⓘ        │                             │
│  [Customize for this platform]      │                             │
│                                     │                             │
│  After customize:                   │                             │
│  • Post type: [Reel ▾]              │                             │
│  • First comment: [...]             │                             │
│  • Reply control: [Everyone ▾]      │                             │
│  • [Reset to Original]              │                             │
│                                     │                             │
│  AI panel (right of editor):        │                             │
│  • Suggest hashtags                 │                             │
│  • Optimize for {platform}          │                             │
│  • Generate variants                 │                             │
├────────────────────────────────────┴─────────────────────────────┤
│ Schedule mode: [All same time ▾] [Per-channel]                   │
│   All same time: [📅 Now ▾] / [📅 Tomorrow 6 PM]                  │
│   Per-channel:   Each tab gets its own time picker                │
│                                                                   │
│              [💾 Save Draft]   [Publish ▶]                        │
└──────────────────────────────────────────────────────────────────┘
```

### Tab behavior (platform-grouped — GPT's insight)

- **Original** is always first. Asterisk indicates unsaved changes.
- One tab per **platform** (not per channel). Label shows count: "Twitter (2)" means 2 Twitter accounts selected.
- Inside Twitter tab: account selector (`☑ @account_a  ☑ @account_b`). User can apply settings to all or detach per-account.
- Warning indicators:
  - 🔴 = validation error (required field missing, media incompatible)
  - 🟡 = warning (close to char limit, suboptimal media)
  - ⚠️ = required action (YouTube needs title)

### YouTube special handling (Claude's #2 concern)

YouTube tab renders a **richer settings panel** because video upload is structurally different:

```
[YouTube tab]
  Video:        [drag/drop or pick]  ⚠️ Required
  Title:        [_______________________]   100 chars max
  Description:  [_______________________]   5000 chars max
                [_______________________]
  Tags:         [tag1] [tag2] [+]
  Category:     [Gaming ▾]
  Thumbnail:    [generate ▾] [upload custom]
  Privacy:      [Public ▾]
  Made for kids: ☐
  Comments:     [Allow all ▾]
  Schedule:     inherits from draft schedule
  [Reset to Original]
```

YouTube isn't squeezed into a "tweet-style" tab; the settings panel adapts based on capability registry. Same component, different render based on `composer.supports*` flags.

### Editor (TipTap)

**Decision: TipTap.** Reasons over Lexical (GPT's suggestion):
- Better React ecosystem and SaaS-product battle-testing (Linear, Notion-style products use TipTap variants)
- ProseMirror under the hood — proven foundation, predictable
- Better TypeScript types and docs
- Extension API is plugin-friendly for future poll/carousel/AI blocks

Lexical is also fine; either is light-years better than Quill/Draft.js (which we explicitly reject). TipTap chosen for pragmatic ecosystem reasons.

### AI integration as patch pipeline

AI features return **patch operations**, not raw text replacements. Enables proper undo/redo:

```ts
interface AIPatch {
  field: keyof BaseContent | string
  operation: 'set' | 'append' | 'replace-range'
  value: any
  range?: { from: number; to: number }
}

// AI action signatures
async function suggestHashtags(draft: Draft, platform: SupportedPlatform): Promise<AIPatch[]>
async function optimizeForPlatform(draft: Draft, platform: SupportedPlatform): Promise<AIPatch[]>
async function generateThreadFromLong(draft: Draft): Promise<AIPatch[]>
async function shorten(draft: Draft, targetChars: number): Promise<AIPatch[]>
```

Editor applies patches via TipTap commands → undo/redo works naturally.

---

## 8. L6: Publication Orchestrator

### Per-channel publication state machine

```
draft
  ↓ user clicks Publish OR scheduled time fires
queued
  ↓ orchestrator picks up
publishing                              ← spinner visible
  ↓ per-channel
  ├── success → published                ← terminal
  ├── failure (retryable) → retry_pending
  │     ↓ N retries with backoff
  │     └── exceeded → failed             ← terminal (needs user action)
  └── failure (terminal) → failed         ← e.g., auth_failed, content_rejected
```

### State stored per channel

`posts.targets[]` array already supports this — extend the `PostTarget` shape:

```ts
interface PostTarget {
  channelId: string                     // numeric, stored as string in JSON
  platform: SupportedPlatform
  status: 'queued' | 'publishing' | 'retry_pending' | 'published' | 'failed'
  platformPostId?: string
  platformPostUrl?: string
  publishedAt?: string
  attemptedAt?: string
  errorCode?: 'rate_limited' | 'auth_failed' | 'media_invalid' | 'content_rejected' | 'transient'
  errorMessage?: string
  retryCount: number
  nextRetryAt?: string
}
```

### Partial-success handling

User publishes to 3 channels → 2 succeed, 1 fails. UI shows:

```
Publishing results:
  ✅ Twitter @asad — Published 2s ago [View]
  ✅ Instagram @asadm — Published 4s ago [View]
  ❌ YouTube — Failed: video processing error
       [Retry] [Edit & Retry] [Skip this channel]
```

User can retry, edit the failed channel and retry, or skip (mark as terminally failed). The draft stays as `partial_success` until user resolves all failures.

### Backend job

Existing BullMQ queue `POST_PUBLISHING` already exists. Extend the processor to:
1. Read draft + resolve payload per channel via `resolvePublicationPayload`
2. Dispatch per-channel to existing platform publishers (already 8 publishers exist in `src/posts/publishers/`)
3. Update each `PostTarget` status
4. Emit WebSocket events on each per-channel state change (UI updates live without polling)

---

## 9. Per-Platform Capability Reference

Concrete field lists each platform needs. Source for the capability registry entries.

### Twitter
- Body text (280 chars)
- Up to 4 images OR 1 video (≤2:20 free tier, ≤140min Basic)
- Thread mode (chained tweets)
- Reply controls (everyone / following / mentioned only)
- Poll (4 options, 5min–7day duration)
- Schedule

### Instagram (Business)
- Caption (2200 chars, ~30 hashtag soft limit)
- Post type: Feed / Reel / Story / Carousel
- Media required (image for feed, video for reel, etc.)
- First comment (for hashtag stuffing trick)
- Location tag
- User tags (mention in image)
- Cross-post to Facebook Page toggle
- Reel-specific: cover frame select, music (limited via API)
- Story-specific: stickers (limited API support)
- Schedule

### YouTube
- Video file (required)
- Title (100 chars, required)
- Description (5000 chars)
- Tags
- Category dropdown (Gaming, Education, etc.)
- Thumbnail (auto or upload)
- Privacy (public / unlisted / private)
- Made-for-kids flag
- Allow comments / ratings
- Playlist add
- Premiere mode (scheduled live)
- Schedule

### Facebook Page
- Message body (long-form OK)
- Media (image / video / link)
- First comment
- Audience targeting
- Schedule

### LinkedIn (Personal & Company Page)
- Body (3000 chars)
- Article mode (long-form)
- Visibility (public / connections-only)
- Media (image / video / document / article link)
- Mentions
- Hashtags inline (typically 3–5 used)
- Schedule
- First comment

### TikTok
- Caption (2200 chars)
- Video (required, 9:16, ≤10min)
- Cover frame selection
- Privacy (public / friends / private)
- Allow comments / duets / stitches
- Schedule

### Pinterest
- Title (100 chars)
- Description (500 chars)
- Image (required, vertical 2:3 recommended)
- Destination link
- Board (required)
- Schedule

### Threads
- Text (500 chars)
- Media (image / video)
- Reply controls (everyone / followed / mentioned)
- Schedule (limited support)

### Bluesky
- Text (300 chars)
- Media (≤4 images, video limited)
- Reply controls
- Thread mode

### Mastodon
- Text (default 500, varies per instance)
- Content warning toggle
- Visibility (public / unlisted / followers / direct)
- Media (with sensitive flag)
- Poll
- Schedule

---

## 10. Backend API Surface

New module: `src/posts/composer/` (extends existing `src/posts/`).

### Endpoints

```
POST   /posts/workspaces/:wsId/drafts                  Create empty draft, returns id
GET    /posts/workspaces/:wsId/drafts/:id              Fetch draft (full structure)
PATCH  /posts/workspaces/:wsId/drafts/:id              Auto-save updates (debounced from frontend)
DELETE /posts/workspaces/:wsId/drafts/:id              Discard draft
GET    /posts/workspaces/:wsId/drafts                  List drafts (paginated)

POST   /posts/workspaces/:wsId/drafts/:id/validate     Run validation across selected channels
POST   /posts/workspaces/:wsId/drafts/:id/preview-payload  Resolve payload for a specific channel (debug/preview)

POST   /posts/workspaces/:wsId/drafts/:id/publish      Trigger publish (now or scheduled)
POST   /posts/workspaces/:wsId/drafts/:id/retry/:channelId  Retry single failed channel

POST   /posts/workspaces/:wsId/media/upload            Upload media (existing or new)
POST   /posts/workspaces/:wsId/media/:id/variant       Generate platform variant (crop/compress)

POST   /posts/workspaces/:wsId/composer/ai/:action     AI action — returns AIPatch[]
  Actions: suggest-hashtags, optimize-platform, generate-thread, shorten, expand, generate-variants
```

### Schema additions

Extend existing `posts` table to support draft state:
- `posts.status` enum gets new value: `draft`
- `posts.targets[]` extended with `retryCount`, `nextRetryAt`, `errorCode` fields

New table: `post_drafts` (or reuse `posts` with `status='draft'` and store overrides in `posts.platformContent` jsonb — which already exists in the schema!). Going with the second option: **reuse existing `posts` table**.

```sql
-- posts table already has:
--   id uuid primary key
--   workspace_id uuid
--   created_by_id uuid
--   content text                  -- maps to base.text
--   media_items jsonb             -- maps to base.mediaItems
--   targets jsonb                 -- channel targets + per-channel status
--   status varchar                -- 'draft' | 'scheduled' | 'publishing' | ...
--   scheduled_at timestamptz
--   published_at timestamptz
--   platform_content jsonb        -- maps to perPlatform (the override structure)
--   metadata jsonb                -- everything else
--   created_at, updated_at
```

We reuse this. Our `Draft` interface maps cleanly:
- `Draft.base.text` → `posts.content`
- `Draft.base.mediaItems` → `posts.mediaItems`
- `Draft.perPlatform` → `posts.platformContent`
- `Draft.channels` → `posts.targets`
- `Draft.status` → `posts.status`
- `Draft.schedule.scheduleAt` → `posts.scheduledAt`

**No schema migration needed.** Just service-layer logic on the existing shape.

---

## 11. Phasing — 4 sprints

### Phase 1 (weeks 1–2): Foundation
- L1 Compose Engine — TypeScript types + `resolvePublicationPayload`
- L2 Capability Registry extension (`ComposerCapabilities` added per platform)
- L3 Media Pipeline — validation logic only (no auto-transform yet)
- Backend draft endpoints (CRUD + validate)
- Database: reuse `posts` table, no migration
- Frontend: composer page shell with auto-save, no UI yet

### Phase 2 (weeks 3–4): Single-platform composer (Twitter MVP)
- L4: Twitter Preview Renderer
- L5: Composer UI tabs (Original + Twitter only), editor (TipTap), char counter
- Backend: publish endpoint → existing TwitterPublisher
- L6: Per-channel publish status, partial-success handling, retry endpoint
- WebSocket events for live publish status

### Phase 3 (weeks 5–6): Add 3 priority platforms
Per user preference, likely: **YouTube + Instagram + LinkedIn**
- Capability registry entries for each
- Preview Renderer for each
- Per-platform settings panel render via capability flags
- YouTube special: title + description + thumbnail + video upload
- IG: post type picker (Feed/Reel/Story), first comment
- LinkedIn: visibility, article mode

### Phase 4 (weeks 7–8): Polish + remaining 6 platforms
- Facebook, TikTok, Pinterest, Threads, Bluesky, Mastodon (~1 day each given registry pattern)
- Media auto-transform pipeline (crop/compress/trim)
- AI action pipeline (start with 2 actions: suggest-hashtags, optimize-platform)
- Per-channel scheduling toggle
- Drafts list page

### Deferred (Phase 5+, not in this spec)
- Mobile responsive
- Plugin architecture (polls, carousels, products, custom blocks)
- Cross-platform auto-adaptation (long → thread)
- Version history / time travel
- Bulk CSV upload
- Approval workflows
- Collaborative editing

---

## 12. Success Criteria

The composer is "done" for v1 when:

- ✅ User can compose a post in <30 seconds for a single channel (single-tab flow)
- ✅ User can publish identical content to 5+ channels in <1 minute
- ✅ User can override per-platform without affecting other platforms (verified by inheritance graph)
- ✅ Edit Original → other platforms with no overrides auto-update
- ✅ Edit a per-platform override → only that platform changes
- ✅ "Reset to Original" clears overrides cleanly
- ✅ Media validation surfaces errors BEFORE publish (no silent fail)
- ✅ Partial-success publish shows per-channel status with retry
- ✅ All 10 platforms work end-to-end (composition → preview → publish)
- ✅ YouTube tab renders rich settings (title/desc/thumb) via capability registry
- ✅ Twitter thread mode works (multiple tweets chained)
- ✅ Instagram type picker works (Feed/Reel/Story)
- ✅ Per-channel scheduling works
- ✅ Drafts auto-save and survive page refresh
- ✅ TypeScript strict, no `any` in core engine

---

## 13. Open Questions

1. **Media storage** — do we use existing media-library infrastructure (S3/Cloudinary already in use) or extend it? Currently no answer — investigate during Phase 1.
2. **Schedule conflicts** — if user schedules Twitter for 9 AM and Instagram for 9:01 AM but Instagram requires Twitter to publish first (because of cross-post), how do we handle? Defer to Phase 3 once per-channel scheduling is real.
3. **Media variant generation infra** — server-side (FFmpeg in worker) vs client-side (browser cropping)? Recommend client-side for crop, server-side for video trim. Settle in Phase 4.
4. **AI cost guardrails** — composer AI calls hit token budget. Per-workspace daily cap? Sync to billing module's existing AI usage tracker. Defer detail.

---

## 14. Non-Goals Recap

This spec deliberately excludes (each has its own future revisit):
- Plugin architecture
- Cross-platform auto-adaptation (AI long→thread)
- Mobile responsive
- Quick-Post modal escape hatch
- Bulk CSV
- Approval workflows
- A/B testing
- Collaborative editing
- Version history beyond auto-save

When any of these become a priority, treat as separate spec → plan → implementation cycle.

---

## 15. Editor Decision Confirmation

**TipTap** (over Lexical or Draft.js). Reasons:
- ProseMirror foundation — battle-tested
- Strong React/TypeScript ecosystem
- Extension API maps cleanly to our future plugin needs (polls, AI blocks)
- Used by Linear, GitLab, others at production scale
- Better community/docs than Lexical for SaaS use cases

If reviewer disagrees, swap is contained to Phase 2 editor-setup task.

---

## 16. Implementation handover

After this spec is approved → invoke `superpowers:writing-plans` skill to produce a step-by-step implementation plan for Phase 1 (foundation). Subsequent phases get their own plans after each phase ships and is verified — incremental planning prevents over-commitment on later phases that will inevitably shift based on Phase 1 learnings.
