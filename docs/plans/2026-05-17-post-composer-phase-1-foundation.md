# Post Composer — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data + service layer of the post composer (L1 Compose Engine, L2 Capability Registry extension, L3 Media Validator, backend draft CRUD endpoints, frontend page shell with auto-save). No real UI yet — that lands in Phase 2.

**Architecture:** 6-layer separation per design spec. Phase 1 ships L1+L2+L3 + backend controller + frontend shell. The Draft data model uses sparse per-platform overrides for explicit inheritance resolution. Reuses the existing `posts` table — `posts.platformContent` jsonb maps to `Draft.perPlatform`, `posts.targets` to `Draft.channels`, `posts.status='draft'` for unpublished drafts. No DB migration needed.

**Tech Stack:** NestJS + Drizzle ORM + PostgreSQL (Neon) + Jest. Frontend: Vite + React 19 + TypeScript + Tailwind + React Query. Editor (TipTap) installed in Phase 2.

**Reference spec:** `socialmedia-workspace/docs/specs/2026-05-17-post-composer-design.md`

**Working directories:**
- Backend: `d:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace\`
- Frontend: `d:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend\`

---

## File structure (Phase 1)

### Backend (`socialmedia-workspace/src/posts/composer/`)

```
posts/composer/
├── composer.module.ts                          - NestJS module wiring
├── composer.controller.ts                      - 7 draft endpoints
├── services/
│   ├── composer.service.ts                     - Draft CRUD (uses posts table)
│   ├── payload-resolver.service.ts             - Draft → PublicationPayload per channel
│   ├── composer-validator.service.ts           - Validates payload against capabilities
│   └── media-validator.service.ts              - Media constraint checks
├── types/
│   ├── draft.types.ts                          - Draft, BaseContent, ChannelTarget shapes
│   ├── platform-fields.types.ts                - TwitterFields, InstagramFields, etc.
│   ├── publication-payload.types.ts            - Resolved per-channel payload
│   └── composer-capabilities.types.ts          - ComposerCapabilities, MediaConstraints
└── dto/
    ├── create-draft.dto.ts                     - POST body
    ├── update-draft.dto.ts                     - PATCH body
    └── publish-draft.dto.ts                    - Publish trigger body
```

### Backend (modified)

```
src/channels/analytics/types/platform-capabilities.types.ts
    + ComposerCapabilities field added to PlatformCapabilities interface
src/channels/analytics/platform-capabilities.registry.ts
    + composer: ComposerCapabilities entry added for all 10 platforms (placeholder values)
src/app.module.ts
    + ComposerModule imported
```

### Frontend (`socialmedia-frontend/src/features/composer/`)

```
features/composer/
├── api/
│   └── composer.api.ts                         - Client wrappers
├── types/
│   └── draft.types.ts                          - Hand-crafted matching backend
├── hooks/
│   ├── use-draft.ts                            - Fetch single draft
│   ├── use-create-draft.ts                     - Create mutation
│   └── use-update-draft.ts                     - Auto-save mutation (debounced)
└── pages/
    └── composer-page.tsx                       - Page shell, no real UI yet
```

### Frontend (modified)

```
src/lib/query-client.ts
    + queryKeys.composer.draft(id)
src/router.tsx
    + /w/:workspaceId/compose route
    + /w/:workspaceId/compose/:draftId route
```

---

## Pre-flight checks

Before starting Task 1, verify:

- [ ] **Backend git clean / on a branch**
  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace"
  git status --short
  ```
  Expected: clean tree, or only pre-existing WIP. Note current branch.

- [ ] **Backend build passes baseline**
  ```bash
  npm run build
  ```
  Expected: `nest build` succeeds.

- [ ] **Frontend build passes baseline**
  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend"
  npm run build
  ```
  Expected: clean.

---

## Task 1: Composer module folder + draft types

**Files:**
- Create: `src/posts/composer/types/draft.types.ts`

- [ ] **Step 1: Create directory structure**

  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace"
  mkdir -p src/posts/composer/types src/posts/composer/services src/posts/composer/dto
  ```

- [ ] **Step 2: Write draft.types.ts**

  Create `src/posts/composer/types/draft.types.ts`:

  ```ts
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

  /**
   * Master draft + per-platform overrides. Inheritance is sparse — only
   * fields explicitly present in `overrides` are customized; everything
   * else inherits from `base`.
   */
  export interface Draft {
    id: string;
    workspaceId: string;
    createdById: string;
    status: DraftStatus;
    base: BaseContent;
    perPlatform: PlatformOverrides;
    channels: ChannelTarget[];
    schedule: ScheduleConfig;
    createdAt: string;
    updatedAt: string;
  }

  export type DraftStatus =
    | 'draft'
    | 'scheduled'
    | 'publishing'
    | 'partial_success'
    | 'published'
    | 'failed'
    | 'needs_attention';

  export interface BaseContent {
    text: string;
    mediaItems: DraftMediaItem[];
    hashtags: string[];
    mentions: Array<{ handle: string; platform?: SupportedPlatform }>;
    linkPreview?: { url: string; title?: string; description?: string };
  }

  export interface DraftMediaItem {
    id: string;
    type: 'image' | 'video' | 'gif';
    url: string;
    width?: number;
    height?: number;
    durationSec?: number;
    sizeBytes: number;
    altText?: string;
    variants?: Partial<Record<SupportedPlatform, MediaVariant>>;
  }

  export interface MediaVariant {
    url: string;
    width: number;
    height: number;
    transformations: string[];
  }

  export interface ChannelTarget {
    channelId: string;
    platform: SupportedPlatform;
    scheduleAt?: string;
    publishStatus: PublishStatus;
    platformPostId?: string;
    platformPostUrl?: string;
    errorCode?: PublishErrorCode;
    errorMessage?: string;
    attemptedAt?: string;
    publishedAt?: string;
    retryCount: number;
    nextRetryAt?: string;
  }

  export type PublishStatus =
    | 'queued'
    | 'publishing'
    | 'retry_pending'
    | 'published'
    | 'failed';

  export type PublishErrorCode =
    | 'rate_limited'
    | 'auth_failed'
    | 'media_invalid'
    | 'content_rejected'
    | 'transient'
    | 'permanent';

  export interface ScheduleConfig {
    mode: 'now' | 'all_same_time' | 'per_channel';
    scheduleAt?: string;
  }

  // Forward-declared in platform-fields.types.ts (Task 2)
  export interface PlatformOverrides {
    twitter?: PlatformOverride<unknown>;
    instagram?: PlatformOverride<unknown>;
    youtube?: PlatformOverride<unknown>;
    facebook?: PlatformOverride<unknown>;
    linkedin?: PlatformOverride<unknown>;
    tiktok?: PlatformOverride<unknown>;
    pinterest?: PlatformOverride<unknown>;
    threads?: PlatformOverride<unknown>;
    bluesky?: PlatformOverride<unknown>;
    mastodon?: PlatformOverride<unknown>;
  }

  export interface PlatformOverride<TFields> {
    inheritsFromBase: boolean;
    overrides: Partial<BaseContent>;
    platformSpecific: Partial<TFields>;
  }
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/posts/composer/
  git commit -m "feat(composer): scaffold composer module folder + draft types"
  ```

---

## Task 2: Per-platform field types

**Files:**
- Create: `src/posts/composer/types/platform-fields.types.ts`

- [ ] **Step 1: Write platform-fields.types.ts**

  Create `src/posts/composer/types/platform-fields.types.ts`:

  ```ts
  /**
   * Per-platform field shapes. Each describes the platform-specific knobs
   * available beyond the base content (text, media, hashtags). Composer UI
   * renders settings panels from these via the capability registry.
   */

  export interface TwitterFields {
    threadTweets?: string[]; // additional tweets in the thread
    replyControl?: 'everyone' | 'following' | 'mentioned_only';
    pollOptions?: string[];
    pollDurationMinutes?: number;
  }

  export type InstagramPostType = 'feed' | 'reel' | 'story' | 'carousel';

  export interface InstagramFields {
    postType: InstagramPostType;
    firstComment?: string;
    location?: { id: string; name: string };
    userTags?: Array<{ username: string; x?: number; y?: number }>;
    crossPostToFacebook?: boolean;
    coverFrameSec?: number; // for Reels
  }

  export interface YouTubeFields {
    title: string;
    description: string;
    tags: string[];
    categoryId?: string;
    privacyStatus: 'public' | 'unlisted' | 'private';
    madeForKids: boolean;
    allowComments: boolean;
    allowRatings: boolean;
    playlistId?: string;
    thumbnailMediaId?: string;
    premiereScheduledFor?: string;
  }

  export interface FacebookFields {
    firstComment?: string;
    audienceTargeting?: {
      countries?: string[];
      ageMin?: number;
      ageMax?: number;
      genders?: Array<'male' | 'female'>;
    };
  }

  export interface LinkedInFields {
    visibility: 'public' | 'connections';
    isArticle: boolean;
    firstComment?: string;
  }

  export interface TikTokFields {
    privacyLevel: 'public' | 'friends' | 'private';
    allowComments: boolean;
    allowDuet: boolean;
    allowStitch: boolean;
    coverFrameSec?: number;
    brandedContent?: boolean;
  }

  export interface PinterestFields {
    title: string;
    boardId: string;
    destinationLink?: string;
    altText?: string;
  }

  export interface ThreadsFields {
    replyControl?: 'everyone' | 'followed' | 'mentioned';
  }

  export interface BlueskyFields {
    threadPosts?: string[];
    replyControl?: 'everyone' | 'mentioned' | 'following';
  }

  export interface MastodonFields {
    visibility: 'public' | 'unlisted' | 'private' | 'direct';
    contentWarning?: string;
    sensitive: boolean;
    pollOptions?: string[];
    pollExpiresInSec?: number;
  }
  ```

- [ ] **Step 2: Update draft.types.ts to use these properly**

  Open `src/posts/composer/types/draft.types.ts`. Replace the `PlatformOverrides` block with strongly-typed versions:

  ```ts
  // Add at top:
  import type {
    TwitterFields,
    InstagramFields,
    YouTubeFields,
    FacebookFields,
    LinkedInFields,
    TikTokFields,
    PinterestFields,
    ThreadsFields,
    BlueskyFields,
    MastodonFields,
  } from './platform-fields.types';

  // Replace PlatformOverrides with:
  export interface PlatformOverrides {
    twitter?: PlatformOverride<TwitterFields>;
    instagram?: PlatformOverride<InstagramFields>;
    youtube?: PlatformOverride<YouTubeFields>;
    facebook?: PlatformOverride<FacebookFields>;
    linkedin?: PlatformOverride<LinkedInFields>;
    tiktok?: PlatformOverride<TikTokFields>;
    pinterest?: PlatformOverride<PinterestFields>;
    threads?: PlatformOverride<ThreadsFields>;
    bluesky?: PlatformOverride<BlueskyFields>;
    mastodon?: PlatformOverride<MastodonFields>;
  }
  ```

- [ ] **Step 3: Build**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/posts/composer/types/
  git commit -m "feat(composer): per-platform field type definitions for all 10 platforms"
  ```

---

## Task 3: PublicationPayload type

**Files:**
- Create: `src/posts/composer/types/publication-payload.types.ts`

- [ ] **Step 1: Write the type**

  Create `src/posts/composer/types/publication-payload.types.ts`:

  ```ts
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import type { BaseContent, DraftMediaItem } from './draft.types';

  /**
   * The result of resolving a Draft against a specific ChannelTarget.
   * This is what the Publication Orchestrator (Phase 2) and Preview
   * Renderers (Phase 2) consume — NOT the raw draft state. Single
   * source of truth for "what will actually publish to this channel."
   */
  export interface PublicationPayload {
    channelId: string;
    platform: SupportedPlatform;
    text: string;
    mediaItems: DraftMediaItem[];
    hashtags: string[];
    mentions: BaseContent['mentions'];
    linkPreview?: BaseContent['linkPreview'];
    platformSpecific: Record<string, unknown>; // narrowed by platform in consumers
    scheduleAt?: string;
  }
  ```

- [ ] **Step 2: Build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/posts/composer/types/publication-payload.types.ts
  git commit -m "feat(composer): PublicationPayload type — normalized per-channel publish shape"
  ```

---

## Task 4: ComposerCapabilities type + MediaConstraints

**Files:**
- Create: `src/posts/composer/types/composer-capabilities.types.ts`

- [ ] **Step 1: Write the types**

  Create `src/posts/composer/types/composer-capabilities.types.ts`:

  ```ts
  /**
   * Per-platform composer capabilities. Drives:
   *   - UI rendering (which settings panel fields to show)
   *   - Validation (which fields are required)
   *   - Media validation (size/format/duration limits)
   *   - AI prompts (which features the platform supports)
   *
   * Adding a new platform = adding a registry entry. No UI code changes.
   */
  export interface ComposerCapabilities {
    // Content fields supported
    supportsTitle: boolean;
    supportsBody: boolean;
    supportsDescription: boolean;
    supportsHashtags: boolean;
    supportsFirstComment: boolean;
    supportsThread: boolean;
    supportsPoll: boolean;
    supportsLocation: boolean;
    supportsMentions: boolean;
    supportsLinkPreview: boolean;

    // Platform-specific knobs (enum-like option sets)
    postTypes: string[]; // ['feed','reel','story'] for IG
    visibilityOptions: string[];
    replyControlOptions: string[];

    // Character limits
    maxCharsTitle?: number;
    maxCharsBody: number;
    maxCharsDescription?: number;
    maxCharsFirstComment?: number;

    // Media
    mediaConstraints: MediaConstraints;

    // Validation
    requiredFields: string[]; // e.g., ['title','description','video'] for YT
  }

  export interface MediaConstraints {
    imageMaxCount: number;
    imageMaxSizeMB: number;
    imageAllowedTypes: string[];
    imageAspectRatios: string[];

    videoMaxCount: number;
    videoMaxSizeMB: number;
    videoMaxDurationSec: number;
    videoMinDurationSec?: number;
    videoAllowedTypes: string[];
    videoAspectRatios: string[];

    carouselMaxCount?: number;
    requiresThumbnail?: boolean;
    requiresMediaOfType?: 'video' | 'image';
  }
  ```

- [ ] **Step 2: Build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/posts/composer/types/composer-capabilities.types.ts
  git commit -m "feat(composer): ComposerCapabilities + MediaConstraints types"
  ```

---

## Task 5: Extend PlatformCapabilities with composer field

**Files:**
- Modify: `src/channels/analytics/types/platform-capabilities.types.ts`

- [ ] **Step 1: Read current file**

  ```bash
  cat src/channels/analytics/types/platform-capabilities.types.ts
  ```

  Confirm it has the existing `PlatformCapabilities` interface used by analytics.

- [ ] **Step 2: Add composer field**

  Open the file. At the top, add the import:

  ```ts
  import type { ComposerCapabilities } from '../../../posts/composer/types/composer-capabilities.types';
  ```

  In the `PlatformCapabilities` interface, add:

  ```ts
  composer?: ComposerCapabilities;
  ```

  (Optional for now — registry will populate it in Task 6. Marking optional avoids breaking the analytics code that doesn't read it.)

- [ ] **Step 3: Build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/types/platform-capabilities.types.ts
  git commit -m "feat(composer): extend PlatformCapabilities with composer sub-field"
  ```

---

## Task 6: Populate composer capabilities in registry (placeholder values for 10 platforms)

**Files:**
- Modify: `src/channels/analytics/platform-capabilities.registry.ts`

- [ ] **Step 1: Read current file**

  ```bash
  cat src/channels/analytics/platform-capabilities.registry.ts
  ```

  Note the existing per-platform `PlatformCapabilities` const exports (YOUTUBE_CAPABILITIES, BLUESKY_CAPABILITIES, etc.) and the registry override pattern at the bottom.

- [ ] **Step 2: Define composer capabilities for each platform**

  At the top of the file, before any platform `*_CAPABILITIES` constants, add 10 composer capability constants. Use the spec's section 9 (Per-Platform Capability Reference) as ground truth:

  ```ts
  import type {
    ComposerCapabilities,
    MediaConstraints,
  } from '../../posts/composer/types/composer-capabilities.types';

  // Twitter — 280 chars, 4 images OR 1 video
  const TWITTER_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: true,
    supportsPoll: true,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post'],
    visibilityOptions: [],
    replyControlOptions: ['everyone', 'following', 'mentioned_only'],
    maxCharsBody: 280,
    mediaConstraints: {
      imageMaxCount: 4,
      imageMaxSizeMB: 5,
      imageAllowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 512,
      videoMaxDurationSec: 140,
      videoAllowedTypes: ['video/mp4', 'video/mov'],
      videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };

  // Instagram — Feed/Reel/Story, 2200 char caption
  const INSTAGRAM_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: true,
    supportsThread: false,
    supportsPoll: false,
    supportsLocation: true,
    supportsMentions: true,
    supportsLinkPreview: false,
    postTypes: ['feed', 'reel', 'story', 'carousel'],
    visibilityOptions: [],
    replyControlOptions: [],
    maxCharsBody: 2200,
    maxCharsFirstComment: 2200,
    mediaConstraints: {
      imageMaxCount: 10, // carousel
      imageMaxSizeMB: 8,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: ['1:1', '4:5', '16:9'],
      videoMaxCount: 1,
      videoMaxSizeMB: 1024,
      videoMaxDurationSec: 90, // Reel
      videoAllowedTypes: ['video/mp4'],
      videoAspectRatios: ['9:16', '1:1'],
      carouselMaxCount: 10,
      requiresMediaOfType: 'image', // for feed; Reel needs video — refined in Phase 3
    },
    requiredFields: ['body'],
  };

  // YouTube — title required, 5000 char description, video required
  const YOUTUBE_COMPOSER: ComposerCapabilities = {
    supportsTitle: true,
    supportsBody: false,
    supportsDescription: true,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: false,
    supportsPoll: false,
    supportsLocation: false,
    supportsMentions: false,
    supportsLinkPreview: false,
    postTypes: ['video', 'short'],
    visibilityOptions: ['public', 'unlisted', 'private'],
    replyControlOptions: [],
    maxCharsTitle: 100,
    maxCharsBody: 0,
    maxCharsDescription: 5000,
    mediaConstraints: {
      imageMaxCount: 1, // thumbnail
      imageMaxSizeMB: 2,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: ['16:9'],
      videoMaxCount: 1,
      videoMaxSizeMB: 256000,
      videoMaxDurationSec: 43200,
      videoAllowedTypes: ['video/mp4', 'video/mov', 'video/avi'],
      videoAspectRatios: ['16:9', '9:16'],
      requiresThumbnail: true,
      requiresMediaOfType: 'video',
    },
    requiredFields: ['title', 'description', 'video'],
  };

  // Facebook Page
  const FACEBOOK_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: true,
    supportsThread: false,
    supportsPoll: false,
    supportsLocation: true,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post'],
    visibilityOptions: [],
    replyControlOptions: [],
    maxCharsBody: 63206,
    maxCharsFirstComment: 8000,
    mediaConstraints: {
      imageMaxCount: 10,
      imageMaxSizeMB: 30,
      imageAllowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 10240,
      videoMaxDurationSec: 14400,
      videoAllowedTypes: ['video/mp4', 'video/mov'],
      videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };

  // LinkedIn
  const LINKEDIN_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: true,
    supportsThread: false,
    supportsPoll: true,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post', 'article'],
    visibilityOptions: ['public', 'connections'],
    replyControlOptions: [],
    maxCharsBody: 3000,
    maxCharsFirstComment: 1250,
    mediaConstraints: {
      imageMaxCount: 9,
      imageMaxSizeMB: 5,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 5120,
      videoMaxDurationSec: 600,
      videoAllowedTypes: ['video/mp4', 'video/mov'],
      videoAspectRatios: ['16:9', '1:1', '9:16'],
    },
    requiredFields: ['body'],
  };

  // TikTok — video required
  const TIKTOK_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: false,
    supportsPoll: false,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: false,
    postTypes: ['video'],
    visibilityOptions: ['public', 'friends', 'private'],
    replyControlOptions: [],
    maxCharsBody: 2200,
    mediaConstraints: {
      imageMaxCount: 0,
      imageMaxSizeMB: 0,
      imageAllowedTypes: [],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 4096,
      videoMaxDurationSec: 600,
      videoMinDurationSec: 3,
      videoAllowedTypes: ['video/mp4'],
      videoAspectRatios: ['9:16'],
      requiresMediaOfType: 'video',
    },
    requiredFields: ['body', 'video'],
  };

  // Pinterest — title + image + board required
  const PINTEREST_COMPOSER: ComposerCapabilities = {
    supportsTitle: true,
    supportsBody: false,
    supportsDescription: true,
    supportsHashtags: false,
    supportsFirstComment: false,
    supportsThread: false,
    supportsPoll: false,
    supportsLocation: false,
    supportsMentions: false,
    supportsLinkPreview: false,
    postTypes: ['pin'],
    visibilityOptions: [],
    replyControlOptions: [],
    maxCharsTitle: 100,
    maxCharsBody: 0,
    maxCharsDescription: 500,
    mediaConstraints: {
      imageMaxCount: 1,
      imageMaxSizeMB: 32,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: ['2:3'],
      videoMaxCount: 1,
      videoMaxSizeMB: 2048,
      videoMaxDurationSec: 900,
      videoAllowedTypes: ['video/mp4', 'video/mov'],
      videoAspectRatios: ['2:3'],
      requiresMediaOfType: 'image',
    },
    requiredFields: ['title', 'image', 'board'],
  };

  // Threads
  const THREADS_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: true,
    supportsPoll: false,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['thread'],
    visibilityOptions: [],
    replyControlOptions: ['everyone', 'followed', 'mentioned'],
    maxCharsBody: 500,
    mediaConstraints: {
      imageMaxCount: 10,
      imageMaxSizeMB: 8,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 1024,
      videoMaxDurationSec: 300,
      videoAllowedTypes: ['video/mp4'],
      videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };

  // Bluesky
  const BLUESKY_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: true,
    supportsPoll: false,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post'],
    visibilityOptions: [],
    replyControlOptions: ['everyone', 'following', 'mentioned'],
    maxCharsBody: 300,
    mediaConstraints: {
      imageMaxCount: 4,
      imageMaxSizeMB: 1,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: [],
      videoMaxCount: 0,
      videoMaxSizeMB: 0,
      videoMaxDurationSec: 0,
      videoAllowedTypes: [],
      videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };

  // Mastodon — varies per instance; defaults
  const MASTODON_COMPOSER: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: false,
    supportsPoll: true,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post'],
    visibilityOptions: ['public', 'unlisted', 'private', 'direct'],
    replyControlOptions: [],
    maxCharsBody: 500,
    mediaConstraints: {
      imageMaxCount: 4,
      imageMaxSizeMB: 8,
      imageAllowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 99,
      videoMaxDurationSec: 60,
      videoAllowedTypes: ['video/mp4'],
      videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };
  ```

- [ ] **Step 3: Wire composer field into each platform's PlatformCapabilities const**

  Find each existing `*_CAPABILITIES` constant (YOUTUBE_CAPABILITIES, BLUESKY_CAPABILITIES, MASTODON_CAPABILITIES, FACEBOOK_CAPABILITIES, INSTAGRAM_CAPABILITIES, THREADS_CAPABILITIES, PINTEREST_CAPABILITIES, LINKEDIN_CAPABILITIES, TIKTOK_CAPABILITIES, TWITTER_CAPABILITIES) and add `composer: <PLATFORM>_COMPOSER` field to each. Example for YouTube:

  ```ts
  const YOUTUBE_CAPABILITIES: PlatformCapabilities = {
    platform: 'youtube',
    // ...existing fields preserved...
    composer: YOUTUBE_COMPOSER,
  };
  ```

  Apply to all 10 platforms.

- [ ] **Step 4: Build**

  ```bash
  npm run build
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/platform-capabilities.registry.ts
  git commit -m "feat(composer): populate composer capabilities for all 10 platforms"
  ```

---

## Task 7: PayloadResolverService (TDD)

**Files:**
- Create: `src/posts/composer/services/payload-resolver.service.ts`
- Create: `src/posts/composer/services/payload-resolver.service.spec.ts`

- [ ] **Step 1: Write failing tests**

  Create `src/posts/composer/services/payload-resolver.service.spec.ts`:

  ```ts
  import { PayloadResolverService } from './payload-resolver.service';
  import type { Draft, ChannelTarget } from '../types/draft.types';

  describe('PayloadResolverService', () => {
    let service: PayloadResolverService;

    const baseDraft: Draft = {
      id: 'd-1',
      workspaceId: 'ws-1',
      createdById: 'u-1',
      status: 'draft',
      base: {
        text: 'hello world',
        mediaItems: [],
        hashtags: ['ai', 'tech'],
        mentions: [],
      },
      perPlatform: {},
      channels: [],
      schedule: { mode: 'now' },
      createdAt: '2026-05-17T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    };

    const twitterChannel: ChannelTarget = {
      channelId: '53',
      platform: 'twitter',
      publishStatus: 'queued',
      retryCount: 0,
    };

    beforeEach(() => {
      service = new PayloadResolverService();
    });

    it('inherits base.text when no override', () => {
      const payload = service.resolve(baseDraft, twitterChannel);
      expect(payload.text).toBe('hello world');
      expect(payload.hashtags).toEqual(['ai', 'tech']);
    });

    it('uses platform override when present', () => {
      const draft: Draft = {
        ...baseDraft,
        perPlatform: {
          twitter: {
            inheritsFromBase: true,
            overrides: { text: 'twitter-specific text' },
            platformSpecific: {},
          },
        },
      };
      const payload = service.resolve(draft, twitterChannel);
      expect(payload.text).toBe('twitter-specific text');
      expect(payload.hashtags).toEqual(['ai', 'tech']); // not overridden
    });

    it('inherits all fields when overrides empty', () => {
      const draft: Draft = {
        ...baseDraft,
        perPlatform: {
          twitter: { inheritsFromBase: true, overrides: {}, platformSpecific: {} },
        },
      };
      const payload = service.resolve(draft, twitterChannel);
      expect(payload.text).toBe('hello world');
    });

    it('does not affect other platforms when one is overridden', () => {
      const draft: Draft = {
        ...baseDraft,
        perPlatform: {
          twitter: {
            inheritsFromBase: true,
            overrides: { text: 'tw only' },
            platformSpecific: {},
          },
        },
      };
      const igChannel: ChannelTarget = {
        channelId: '49',
        platform: 'instagram',
        publishStatus: 'queued',
        retryCount: 0,
      };
      const payload = service.resolve(draft, igChannel);
      expect(payload.text).toBe('hello world'); // untouched
    });

    it('exposes platformSpecific via the channel platform key', () => {
      const draft: Draft = {
        ...baseDraft,
        perPlatform: {
          youtube: {
            inheritsFromBase: true,
            overrides: {},
            platformSpecific: { title: 'My Video', privacyStatus: 'public' },
          },
        },
      };
      const ytChannel: ChannelTarget = {
        channelId: '54',
        platform: 'youtube',
        publishStatus: 'queued',
        retryCount: 0,
      };
      const payload = service.resolve(draft, ytChannel);
      expect(payload.platformSpecific).toEqual({ title: 'My Video', privacyStatus: 'public' });
    });

    it('uses channel scheduleAt when set', () => {
      const channel: ChannelTarget = {
        ...twitterChannel,
        scheduleAt: '2026-05-18T09:00:00Z',
      };
      const payload = service.resolve(baseDraft, channel);
      expect(payload.scheduleAt).toBe('2026-05-18T09:00:00Z');
    });
  });
  ```

- [ ] **Step 2: Run failing test (module not found)**

  ```bash
  npx jest src/posts/composer/services/payload-resolver.service.spec.ts --no-coverage
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement service**

  Create `src/posts/composer/services/payload-resolver.service.ts`:

  ```ts
  import { Injectable } from '@nestjs/common';
  import type { Draft, ChannelTarget, PlatformOverride } from '../types/draft.types';
  import type { PublicationPayload } from '../types/publication-payload.types';

  /**
   * Resolves a Draft + ChannelTarget into the concrete payload that will
   * publish to that channel. Inheritance is sparse — fields not present
   * in perPlatform.<platform>.overrides inherit from draft.base.
   *
   * This is the SINGLE function. Used by:
   *   - Preview Renderers (Phase 2)
   *   - Publication Orchestrator (Phase 2)
   *   - AI rewrite pipeline (Phase 4)
   */
  @Injectable()
  export class PayloadResolverService {
    resolve(draft: Draft, channel: ChannelTarget): PublicationPayload {
      const override = draft.perPlatform[channel.platform] as
        | PlatformOverride<unknown>
        | undefined;
      const ov = override?.overrides ?? {};

      return {
        channelId: channel.channelId,
        platform: channel.platform,
        text: ov.text ?? draft.base.text,
        mediaItems: ov.mediaItems ?? draft.base.mediaItems,
        hashtags: ov.hashtags ?? draft.base.hashtags,
        mentions: ov.mentions ?? draft.base.mentions,
        linkPreview: ov.linkPreview ?? draft.base.linkPreview,
        platformSpecific: (override?.platformSpecific ?? {}) as Record<string, unknown>,
        scheduleAt: channel.scheduleAt ?? draft.schedule.scheduleAt,
      };
    }
  }
  ```

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/posts/composer/services/payload-resolver.service.spec.ts --no-coverage
  ```

  Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/posts/composer/services/payload-resolver.service.ts src/posts/composer/services/payload-resolver.service.spec.ts
  git commit -m "feat(composer): PayloadResolverService — Draft + Channel → PublicationPayload (TDD'd, 6 tests)"
  ```

---

## Task 8: MediaValidatorService (TDD)

**Files:**
- Create: `src/posts/composer/services/media-validator.service.ts`
- Create: `src/posts/composer/services/media-validator.service.spec.ts`

- [ ] **Step 1: Write failing tests**

  Create the spec file:

  ```ts
  import { MediaValidatorService } from './media-validator.service';
  import type { DraftMediaItem } from '../types/draft.types';
  import type { MediaConstraints } from '../types/composer-capabilities.types';

  describe('MediaValidatorService', () => {
    let service: MediaValidatorService;

    const twitterImageConstraints: MediaConstraints = {
      imageMaxCount: 4,
      imageMaxSizeMB: 5,
      imageAllowedTypes: ['image/jpeg', 'image/png'],
      imageAspectRatios: [],
      videoMaxCount: 1,
      videoMaxSizeMB: 512,
      videoMaxDurationSec: 140,
      videoAllowedTypes: ['video/mp4'],
      videoAspectRatios: [],
    };

    const igReelConstraints: MediaConstraints = {
      ...twitterImageConstraints,
      videoMaxDurationSec: 90,
      videoAspectRatios: ['9:16'],
      requiresMediaOfType: 'video',
    };

    function img(sizeMB: number, type = 'image/jpeg', width = 1080, height = 1080): DraftMediaItem {
      return { id: 'm', type: 'image', url: 'x', sizeBytes: sizeMB * 1024 * 1024, width, height };
    }

    function video(sizeMB: number, durSec: number, width = 1920, height = 1080, type = 'video/mp4'): DraftMediaItem {
      return {
        id: 'm',
        type: 'video',
        url: 'x',
        sizeBytes: sizeMB * 1024 * 1024,
        width,
        height,
        durationSec: durSec,
      };
    }

    beforeEach(() => {
      service = new MediaValidatorService();
    });

    it('passes valid Twitter image', () => {
      const result = service.validate([img(2)], twitterImageConstraints);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects oversize Twitter image', () => {
      const result = service.validate([img(8)], twitterImageConstraints);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'image_too_large' }));
    });

    it('rejects too many Twitter images', () => {
      const result = service.validate(
        [img(1), img(1), img(1), img(1), img(1)],
        twitterImageConstraints,
      );
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'image_count_exceeded' }));
    });

    it('rejects video exceeding IG Reel duration', () => {
      const result = service.validate([video(200, 120)], igReelConstraints);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'video_too_long' }));
    });

    it('rejects video with wrong aspect ratio for IG Reel', () => {
      const result = service.validate([video(100, 30, 1920, 1080)], igReelConstraints);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'video_aspect_mismatch' }));
    });

    it('rejects when platform requires video but only image present', () => {
      const result = service.validate([img(2)], igReelConstraints);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'media_type_required' }));
    });

    it('passes valid IG Reel video', () => {
      const result = service.validate([video(50, 60, 1080, 1920)], igReelConstraints);
      expect(result.ok).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  ```bash
  npx jest src/posts/composer/services/media-validator.service.spec.ts --no-coverage
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement service**

  Create `src/posts/composer/services/media-validator.service.ts`:

  ```ts
  import { Injectable } from '@nestjs/common';
  import type { DraftMediaItem } from '../types/draft.types';
  import type { MediaConstraints } from '../types/composer-capabilities.types';

  export interface MediaValidationError {
    kind:
      | 'image_too_large'
      | 'image_count_exceeded'
      | 'image_type_unsupported'
      | 'image_aspect_mismatch'
      | 'video_too_large'
      | 'video_count_exceeded'
      | 'video_too_long'
      | 'video_too_short'
      | 'video_type_unsupported'
      | 'video_aspect_mismatch'
      | 'media_type_required'
      | 'thumbnail_required';
    mediaId?: string;
    message: string;
  }

  export interface MediaValidationResult {
    ok: boolean;
    errors: MediaValidationError[];
    warnings: MediaValidationError[];
  }

  /**
   * Validates a media item set against a platform's MediaConstraints.
   * Returns structured errors so the UI can render per-media + per-platform
   * indicators (red dots on tabs, tooltips, suggested fixes).
   *
   * Stateless — no DB access. Pure function semantics.
   */
  @Injectable()
  export class MediaValidatorService {
    validate(items: DraftMediaItem[], constraints: MediaConstraints): MediaValidationResult {
      const errors: MediaValidationError[] = [];
      const warnings: MediaValidationError[] = [];

      const images = items.filter((m) => m.type === 'image' || m.type === 'gif');
      const videos = items.filter((m) => m.type === 'video');

      // Required media type check
      if (constraints.requiresMediaOfType === 'video' && videos.length === 0) {
        errors.push({
          kind: 'media_type_required',
          message: 'This platform requires a video to publish',
        });
      }
      if (constraints.requiresMediaOfType === 'image' && images.length === 0) {
        errors.push({
          kind: 'media_type_required',
          message: 'This platform requires an image to publish',
        });
      }

      // Image checks
      if (images.length > constraints.imageMaxCount) {
        errors.push({
          kind: 'image_count_exceeded',
          message: `Too many images: ${images.length}, max ${constraints.imageMaxCount}`,
        });
      }
      for (const img of images) {
        const sizeMB = img.sizeBytes / (1024 * 1024);
        if (sizeMB > constraints.imageMaxSizeMB) {
          errors.push({
            kind: 'image_too_large',
            mediaId: img.id,
            message: `Image ${sizeMB.toFixed(1)}MB exceeds ${constraints.imageMaxSizeMB}MB`,
          });
        }
        if (
          constraints.imageAllowedTypes.length > 0 &&
          !this.matchesAllowedType(img, constraints.imageAllowedTypes)
        ) {
          errors.push({
            kind: 'image_type_unsupported',
            mediaId: img.id,
            message: `Image type not supported on this platform`,
          });
        }
        if (
          constraints.imageAspectRatios.length > 0 &&
          img.width != null &&
          img.height != null &&
          !this.matchesAspect(img.width, img.height, constraints.imageAspectRatios)
        ) {
          errors.push({
            kind: 'image_aspect_mismatch',
            mediaId: img.id,
            message: `Image aspect ratio not supported (allowed: ${constraints.imageAspectRatios.join(', ')})`,
          });
        }
      }

      // Video checks
      if (videos.length > constraints.videoMaxCount) {
        errors.push({
          kind: 'video_count_exceeded',
          message: `Too many videos: ${videos.length}, max ${constraints.videoMaxCount}`,
        });
      }
      for (const v of videos) {
        const sizeMB = v.sizeBytes / (1024 * 1024);
        if (sizeMB > constraints.videoMaxSizeMB) {
          errors.push({
            kind: 'video_too_large',
            mediaId: v.id,
            message: `Video ${sizeMB.toFixed(1)}MB exceeds ${constraints.videoMaxSizeMB}MB`,
          });
        }
        if (v.durationSec != null && v.durationSec > constraints.videoMaxDurationSec) {
          errors.push({
            kind: 'video_too_long',
            mediaId: v.id,
            message: `Video ${v.durationSec}s exceeds ${constraints.videoMaxDurationSec}s`,
          });
        }
        if (
          constraints.videoMinDurationSec != null &&
          v.durationSec != null &&
          v.durationSec < constraints.videoMinDurationSec
        ) {
          errors.push({
            kind: 'video_too_short',
            mediaId: v.id,
            message: `Video ${v.durationSec}s under minimum ${constraints.videoMinDurationSec}s`,
          });
        }
        if (
          constraints.videoAspectRatios.length > 0 &&
          v.width != null &&
          v.height != null &&
          !this.matchesAspect(v.width, v.height, constraints.videoAspectRatios)
        ) {
          errors.push({
            kind: 'video_aspect_mismatch',
            mediaId: v.id,
            message: `Video aspect ratio not supported (allowed: ${constraints.videoAspectRatios.join(', ')})`,
          });
        }
      }

      return { ok: errors.length === 0, errors, warnings };
    }

    private matchesAllowedType(_item: DraftMediaItem, _allowed: string[]): boolean {
      // We don't store mime type on DraftMediaItem yet; infer from extension during upload
      // For now accept everything — refined when upload pipeline lands.
      return true;
    }

    private matchesAspect(width: number, height: number, allowed: string[]): boolean {
      const actual = width / height;
      for (const ratio of allowed) {
        const [w, h] = ratio.split(':').map(Number);
        const target = w / h;
        if (Math.abs(actual - target) < 0.05) return true; // 5% tolerance
      }
      return false;
    }
  }
  ```

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/posts/composer/services/media-validator.service.spec.ts --no-coverage
  ```

  Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/posts/composer/services/media-validator.service.ts src/posts/composer/services/media-validator.service.spec.ts
  git commit -m "feat(composer): MediaValidatorService — per-platform media constraint checks (TDD'd, 7 tests)"
  ```

---

## Task 9: ComposerValidatorService (TDD)

**Files:**
- Create: `src/posts/composer/services/composer-validator.service.ts`
- Create: `src/posts/composer/services/composer-validator.service.spec.ts`

- [ ] **Step 1: Write failing tests**

  Create the spec:

  ```ts
  import { ComposerValidatorService } from './composer-validator.service';
  import type { PublicationPayload } from '../types/publication-payload.types';
  import type { ComposerCapabilities } from '../types/composer-capabilities.types';

  describe('ComposerValidatorService', () => {
    let service: ComposerValidatorService;

    const twitterCaps: ComposerCapabilities = {
      supportsTitle: false,
      supportsBody: true,
      supportsDescription: false,
      supportsHashtags: true,
      supportsFirstComment: false,
      supportsThread: true,
      supportsPoll: true,
      supportsLocation: false,
      supportsMentions: true,
      supportsLinkPreview: true,
      postTypes: ['post'],
      visibilityOptions: [],
      replyControlOptions: [],
      maxCharsBody: 280,
      mediaConstraints: {
        imageMaxCount: 4, imageMaxSizeMB: 5, imageAllowedTypes: [], imageAspectRatios: [],
        videoMaxCount: 1, videoMaxSizeMB: 512, videoMaxDurationSec: 140,
        videoAllowedTypes: [], videoAspectRatios: [],
      },
      requiredFields: ['body'],
    };

    const ytCaps: ComposerCapabilities = {
      ...twitterCaps,
      supportsTitle: true,
      supportsBody: false,
      supportsDescription: true,
      maxCharsTitle: 100,
      maxCharsBody: 0,
      maxCharsDescription: 5000,
      requiredFields: ['title', 'description'],
    };

    function payload(text: string): PublicationPayload {
      return {
        channelId: '1',
        platform: 'twitter',
        text,
        mediaItems: [],
        hashtags: [],
        mentions: [],
        platformSpecific: {},
      };
    }

    beforeEach(() => {
      service = new ComposerValidatorService();
    });

    it('passes valid Twitter body', () => {
      const r = service.validate(payload('Hello world'), twitterCaps);
      expect(r.ok).toBe(true);
    });

    it('rejects body over char limit', () => {
      const r = service.validate(payload('x'.repeat(281)), twitterCaps);
      expect(r.ok).toBe(false);
      expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'body_too_long' }));
    });

    it('warns near char limit (>=90%)', () => {
      const r = service.validate(payload('x'.repeat(260)), twitterCaps);
      expect(r.ok).toBe(true);
      expect(r.warnings).toContainEqual(expect.objectContaining({ kind: 'body_near_limit' }));
    });

    it('rejects empty body when required', () => {
      const r = service.validate(payload(''), twitterCaps);
      expect(r.ok).toBe(false);
      expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'required_field_missing', field: 'body' }));
    });

    it('rejects YT payload missing title', () => {
      const r = service.validate(
        { ...payload(''), platformSpecific: { description: 'desc' } },
        ytCaps,
      );
      expect(r.ok).toBe(false);
      expect(r.errors).toContainEqual(
        expect.objectContaining({ kind: 'required_field_missing', field: 'title' }),
      );
    });

    it('rejects YT title over 100 chars', () => {
      const r = service.validate(
        { ...payload(''), platformSpecific: { title: 'x'.repeat(101), description: 'd' } },
        ytCaps,
      );
      expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'title_too_long' }));
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  ```bash
  npx jest src/posts/composer/services/composer-validator.service.spec.ts --no-coverage
  ```

- [ ] **Step 3: Implement**

  Create `src/posts/composer/services/composer-validator.service.ts`:

  ```ts
  import { Inject, Injectable } from '@nestjs/common';
  import type { PublicationPayload } from '../types/publication-payload.types';
  import type { ComposerCapabilities } from '../types/composer-capabilities.types';
  import { MediaValidatorService } from './media-validator.service';

  export interface ComposerValidationError {
    kind:
      | 'body_too_long'
      | 'title_too_long'
      | 'description_too_long'
      | 'first_comment_too_long'
      | 'required_field_missing'
      | 'unsupported_feature'
      | 'media_invalid';
    field?: string;
    message: string;
  }

  export interface ComposerValidationResult {
    ok: boolean;
    errors: ComposerValidationError[];
    warnings: ComposerValidationError[];
  }

  const WARNING_THRESHOLD = 0.9;

  @Injectable()
  export class ComposerValidatorService {
    constructor(private readonly mediaValidator: MediaValidatorService) {}

    validate(payload: PublicationPayload, caps: ComposerCapabilities): ComposerValidationResult {
      const errors: ComposerValidationError[] = [];
      const warnings: ComposerValidationError[] = [];

      // Body length
      if (caps.supportsBody) {
        if (payload.text.length > caps.maxCharsBody) {
          errors.push({
            kind: 'body_too_long',
            field: 'body',
            message: `Body ${payload.text.length} chars exceeds ${caps.maxCharsBody}`,
          });
        } else if (
          caps.maxCharsBody > 0 &&
          payload.text.length / caps.maxCharsBody >= WARNING_THRESHOLD
        ) {
          warnings.push({
            kind: 'body_near_limit',
            field: 'body',
            message: `Body close to ${caps.maxCharsBody} char limit`,
          } as ComposerValidationError);
        }
      }

      // Required fields
      for (const required of caps.requiredFields) {
        const present = this.fieldPresent(required, payload, caps);
        if (!present) {
          errors.push({
            kind: 'required_field_missing',
            field: required,
            message: `Required field '${required}' is missing or empty`,
          });
        }
      }

      // Title length (YT, Pinterest)
      const title = (payload.platformSpecific.title as string | undefined) ?? '';
      if (caps.supportsTitle && caps.maxCharsTitle && title.length > caps.maxCharsTitle) {
        errors.push({
          kind: 'title_too_long',
          field: 'title',
          message: `Title ${title.length} chars exceeds ${caps.maxCharsTitle}`,
        });
      }

      // Description length
      const desc = (payload.platformSpecific.description as string | undefined) ?? '';
      if (
        caps.supportsDescription &&
        caps.maxCharsDescription &&
        desc.length > caps.maxCharsDescription
      ) {
        errors.push({
          kind: 'description_too_long',
          field: 'description',
          message: `Description ${desc.length} chars exceeds ${caps.maxCharsDescription}`,
        });
      }

      // Media validation
      const mediaResult = this.mediaValidator.validate(payload.mediaItems, caps.mediaConstraints);
      for (const e of mediaResult.errors) {
        errors.push({ kind: 'media_invalid', field: 'media', message: e.message });
      }

      return { ok: errors.length === 0, errors, warnings };
    }

    private fieldPresent(
      field: string,
      payload: PublicationPayload,
      _caps: ComposerCapabilities,
    ): boolean {
      switch (field) {
        case 'body':
          return payload.text.trim().length > 0;
        case 'title':
          return Boolean((payload.platformSpecific.title as string | undefined)?.trim());
        case 'description':
          return Boolean((payload.platformSpecific.description as string | undefined)?.trim());
        case 'image':
          return payload.mediaItems.some((m) => m.type === 'image');
        case 'video':
          return payload.mediaItems.some((m) => m.type === 'video');
        case 'board':
          return Boolean((payload.platformSpecific.boardId as string | undefined)?.trim());
        default:
          return Boolean((payload.platformSpecific as Record<string, unknown>)[field]);
      }
    }
  }
  ```

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/posts/composer/services/composer-validator.service.spec.ts --no-coverage
  ```

  Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/posts/composer/services/composer-validator.service.ts src/posts/composer/services/composer-validator.service.spec.ts
  git commit -m "feat(composer): ComposerValidatorService — char limits + required fields + media (TDD'd, 6 tests)"
  ```

---

## Task 10: ComposerService (draft CRUD on posts table)

**Files:**
- Create: `src/posts/composer/services/composer.service.ts`
- Create: `src/posts/composer/dto/create-draft.dto.ts`
- Create: `src/posts/composer/dto/update-draft.dto.ts`

- [ ] **Step 1: Write DTOs**

  Create `src/posts/composer/dto/create-draft.dto.ts`:

  ```ts
  export class CreateDraftDto {
    // Empty body is fine — creates an empty draft user can fill in
  }
  ```

  Create `src/posts/composer/dto/update-draft.dto.ts`:

  ```ts
  import type { BaseContent, PlatformOverrides, ChannelTarget, ScheduleConfig } from '../types/draft.types';

  export class UpdateDraftDto {
    base?: Partial<BaseContent>;
    perPlatform?: PlatformOverrides;
    channels?: ChannelTarget[];
    schedule?: ScheduleConfig;
  }
  ```

- [ ] **Step 2: Write the service**

  Create `src/posts/composer/services/composer.service.ts`:

  ```ts
  import { Inject, Injectable, NotFoundException } from '@nestjs/common';
  import { and, eq, desc } from 'drizzle-orm';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { posts } from '../../../drizzle/schema/posts.schema';
  import type { Draft, BaseContent, PlatformOverrides, ChannelTarget, ScheduleConfig } from '../types/draft.types';
  import type { CreateDraftDto } from '../dto/create-draft.dto';
  import type { UpdateDraftDto } from '../dto/update-draft.dto';

  /**
   * Draft CRUD service. Stores drafts as rows in the existing `posts` table
   * with status='draft'. No schema migration needed — the table already has
   * platformContent (jsonb) for perPlatform and targets (jsonb) for channels.
   */
  @Injectable()
  export class ComposerService {
    constructor(@Inject(DRIZZLE) private readonly db: any) {}

    async create(workspaceId: string, userId: string, _dto: CreateDraftDto): Promise<Draft> {
      const inserted = await this.db
        .insert(posts)
        .values({
          workspaceId,
          createdById: userId,
          content: '',
          mediaItems: [],
          targets: [],
          status: 'draft',
          platformContent: {},
          metadata: {},
        })
        .returning();

      return this.toDraft(inserted[0]);
    }

    async findById(workspaceId: string, draftId: string): Promise<Draft> {
      const rows = await this.db
        .select()
        .from(posts)
        .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
        .limit(1);

      if (rows.length === 0) {
        throw new NotFoundException(`Draft ${draftId} not found`);
      }
      return this.toDraft(rows[0]);
    }

    async listDrafts(workspaceId: string, limit = 50): Promise<Draft[]> {
      const rows = await this.db
        .select()
        .from(posts)
        .where(and(eq(posts.workspaceId, workspaceId), eq(posts.status, 'draft')))
        .orderBy(desc(posts.updatedAt))
        .limit(limit);

      return rows.map((r: any) => this.toDraft(r));
    }

    async update(workspaceId: string, draftId: string, dto: UpdateDraftDto): Promise<Draft> {
      const existing = await this.findById(workspaceId, draftId);
      const newBase = dto.base ? { ...existing.base, ...dto.base } : existing.base;

      const updated = await this.db
        .update(posts)
        .set({
          content: newBase.text,
          mediaItems: newBase.mediaItems,
          platformContent: dto.perPlatform ?? existing.perPlatform,
          targets: (dto.channels ?? existing.channels) as any,
          scheduledAt: dto.schedule?.scheduleAt ? new Date(dto.schedule.scheduleAt) : null,
          metadata: {
            hashtags: newBase.hashtags,
            mentions: newBase.mentions,
            linkPreview: newBase.linkPreview,
            schedule: dto.schedule ?? existing.schedule,
          },
          updatedAt: new Date(),
        })
        .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
        .returning();

      return this.toDraft(updated[0]);
    }

    async delete(workspaceId: string, draftId: string): Promise<{ success: true }> {
      await this.db
        .delete(posts)
        .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
      return { success: true };
    }

    private toDraft(row: any): Draft {
      const metadata = (row.metadata ?? {}) as Record<string, any>;
      const base: BaseContent = {
        text: row.content ?? '',
        mediaItems: (row.mediaItems ?? []) as BaseContent['mediaItems'],
        hashtags: (metadata.hashtags ?? []) as string[],
        mentions: (metadata.mentions ?? []) as BaseContent['mentions'],
        linkPreview: metadata.linkPreview,
      };
      const schedule: ScheduleConfig = metadata.schedule ?? {
        mode: row.scheduledAt ? 'all_same_time' : 'now',
        scheduleAt: row.scheduledAt?.toISOString?.(),
      };
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        createdById: row.createdById,
        status: (row.status ?? 'draft') as Draft['status'],
        base,
        perPlatform: (row.platformContent ?? {}) as PlatformOverrides,
        channels: (row.targets ?? []) as ChannelTarget[],
        schedule,
        createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
      };
    }
  }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/posts/composer/services/composer.service.ts src/posts/composer/dto/
  git commit -m "feat(composer): ComposerService — draft CRUD against existing posts table"
  ```

---

## Task 11: ComposerController (endpoints)

**Files:**
- Create: `src/posts/composer/composer.controller.ts`

- [ ] **Step 1: Write the controller**

  Create `src/posts/composer/composer.controller.ts`:

  ```ts
  import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
  } from '@nestjs/common';
  import { AuthGuard } from '@nestjs/passport';
  import { CurrentUser } from '../../auth/decorators/current-user.decorator';
  import { ComposerService } from './services/composer.service';
  import { ComposerValidatorService } from './services/composer-validator.service';
  import { PayloadResolverService } from './services/payload-resolver.service';
  import { getCapabilities } from '../../channels/analytics/platform-capabilities.registry';
  import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
  import { CreateDraftDto } from './dto/create-draft.dto';
  import { UpdateDraftDto } from './dto/update-draft.dto';

  @Controller('posts/workspaces/:wsId/composer')
  @UseGuards(AuthGuard('jwt'))
  export class ComposerController {
    constructor(
      private readonly composer: ComposerService,
      private readonly validator: ComposerValidatorService,
      private readonly resolver: PayloadResolverService,
    ) {}

    @Post('drafts')
    async createDraft(
      @Param('wsId') wsId: string,
      @CurrentUser() user: { userId: string },
      @Body() dto: CreateDraftDto,
    ) {
      return this.composer.create(wsId, user.userId, dto);
    }

    @Get('drafts')
    async listDrafts(
      @Param('wsId') wsId: string,
      @Query('limit') limitStr?: string,
    ) {
      const limit = limitStr ? Number(limitStr) : 50;
      return this.composer.listDrafts(wsId, limit);
    }

    @Get('drafts/:draftId')
    async getDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
      return this.composer.findById(wsId, draftId);
    }

    @Patch('drafts/:draftId')
    async updateDraft(
      @Param('wsId') wsId: string,
      @Param('draftId') draftId: string,
      @Body() dto: UpdateDraftDto,
    ) {
      return this.composer.update(wsId, draftId, dto);
    }

    @Delete('drafts/:draftId')
    async deleteDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
      return this.composer.delete(wsId, draftId);
    }

    @Post('drafts/:draftId/validate')
    async validateDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
      const draft = await this.composer.findById(wsId, draftId);
      const perChannel: Array<{
        channelId: string;
        platform: SupportedPlatform;
        ok: boolean;
        errors: any[];
        warnings: any[];
      }> = [];

      for (const channel of draft.channels) {
        const payload = this.resolver.resolve(draft, channel);
        const caps = getCapabilities(channel.platform);
        if (!caps.composer) {
          perChannel.push({
            channelId: channel.channelId,
            platform: channel.platform,
            ok: false,
            errors: [{ kind: 'unsupported_feature', message: 'No composer capabilities for platform' }],
            warnings: [],
          });
          continue;
        }
        const r = this.validator.validate(payload, caps.composer);
        perChannel.push({
          channelId: channel.channelId,
          platform: channel.platform,
          ok: r.ok,
          errors: r.errors,
          warnings: r.warnings,
        });
      }

      return { ok: perChannel.every((c) => c.ok), perChannel };
    }

    @Post('drafts/:draftId/preview-payload')
    async previewPayload(
      @Param('wsId') wsId: string,
      @Param('draftId') draftId: string,
      @Body() body: { channelId: string },
    ) {
      const draft = await this.composer.findById(wsId, draftId);
      const channel = draft.channels.find((c) => c.channelId === body.channelId);
      if (!channel) {
        throw new BadRequestException(`Channel ${body.channelId} not selected on this draft`);
      }
      return this.resolver.resolve(draft, channel);
    }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

  Expected: PASS — but may fail if `CurrentUser` decorator or `AuthGuard` import paths differ. Check via:

  ```bash
  grep -rn "CurrentUser\|AuthGuard" src/posts/posts.controller.ts | head -5
  ```

  Match the import paths the existing posts.controller.ts uses.

- [ ] **Step 3: Commit**

  ```bash
  git add src/posts/composer/composer.controller.ts
  git commit -m "feat(composer): ComposerController with 7 endpoints (CRUD + validate + preview-payload)"
  ```

---

## Task 12: ComposerModule wiring

**Files:**
- Create: `src/posts/composer/composer.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write the module**

  Create `src/posts/composer/composer.module.ts`:

  ```ts
  import { Module } from '@nestjs/common';
  import { ComposerController } from './composer.controller';
  import { ComposerService } from './services/composer.service';
  import { ComposerValidatorService } from './services/composer-validator.service';
  import { MediaValidatorService } from './services/media-validator.service';
  import { PayloadResolverService } from './services/payload-resolver.service';

  @Module({
    controllers: [ComposerController],
    providers: [
      ComposerService,
      ComposerValidatorService,
      MediaValidatorService,
      PayloadResolverService,
    ],
    exports: [
      ComposerService,
      ComposerValidatorService,
      PayloadResolverService,
    ],
  })
  export class ComposerModule {}
  ```

- [ ] **Step 2: Register in AppModule**

  Modify `src/app.module.ts`:

  - Add import: `import { ComposerModule } from './posts/composer/composer.module';`
  - Add `ComposerModule` to the `imports` array (preserving order, append at end)

- [ ] **Step 3: Build + start dev server briefly**

  ```bash
  npm run build
  timeout 12 npm run start:dev 2>&1 | grep -iE "ComposerController|Mapped.*composer|application successfully started" | head -20
  ```

  Expected: see routes mapped:
  - `/posts/workspaces/:wsId/composer/drafts (POST)`
  - `/posts/workspaces/:wsId/composer/drafts (GET)`
  - `/posts/workspaces/:wsId/composer/drafts/:draftId (GET)`
  - `/posts/workspaces/:wsId/composer/drafts/:draftId (PATCH)`
  - `/posts/workspaces/:wsId/composer/drafts/:draftId (DELETE)`
  - `/posts/workspaces/:wsId/composer/drafts/:draftId/validate (POST)`
  - `/posts/workspaces/:wsId/composer/drafts/:draftId/preview-payload (POST)`
  - `Nest application successfully started`

- [ ] **Step 4: Commit**

  ```bash
  git add src/posts/composer/composer.module.ts src/app.module.ts
  git commit -m "feat(composer): wire ComposerModule into AppModule"
  ```

---

## Task 13: Frontend types

**Files:**
- Create: `src/features/composer/types/draft.types.ts`

- [ ] **Step 1: Create directory + write types**

  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend"
  mkdir -p src/features/composer/types src/features/composer/api src/features/composer/hooks src/features/composer/pages
  ```

  Create `src/features/composer/types/draft.types.ts`:

  ```ts
  import type { SocialPlatform } from '@/features/onboarding/constants'

  export type DraftStatus =
    | 'draft'
    | 'scheduled'
    | 'publishing'
    | 'partial_success'
    | 'published'
    | 'failed'
    | 'needs_attention'

  export type PublishStatus =
    | 'queued'
    | 'publishing'
    | 'retry_pending'
    | 'published'
    | 'failed'

  export type PublishErrorCode =
    | 'rate_limited'
    | 'auth_failed'
    | 'media_invalid'
    | 'content_rejected'
    | 'transient'
    | 'permanent'

  export interface DraftMediaItem {
    id: string
    type: 'image' | 'video' | 'gif'
    url: string
    width?: number
    height?: number
    durationSec?: number
    sizeBytes: number
    altText?: string
  }

  export interface BaseContent {
    text: string
    mediaItems: DraftMediaItem[]
    hashtags: string[]
    mentions: Array<{ handle: string; platform?: SocialPlatform }>
    linkPreview?: { url: string; title?: string; description?: string }
  }

  export interface PlatformOverride<TFields = Record<string, unknown>> {
    inheritsFromBase: boolean
    overrides: Partial<BaseContent>
    platformSpecific: Partial<TFields>
  }

  export type PlatformOverrides = Partial<Record<SocialPlatform, PlatformOverride>>

  export interface ChannelTarget {
    channelId: string
    platform: SocialPlatform
    scheduleAt?: string
    publishStatus: PublishStatus
    platformPostId?: string
    platformPostUrl?: string
    errorCode?: PublishErrorCode
    errorMessage?: string
    attemptedAt?: string
    publishedAt?: string
    retryCount: number
    nextRetryAt?: string
  }

  export interface ScheduleConfig {
    mode: 'now' | 'all_same_time' | 'per_channel'
    scheduleAt?: string
  }

  export interface Draft {
    id: string
    workspaceId: string
    createdById: string
    status: DraftStatus
    base: BaseContent
    perPlatform: PlatformOverrides
    channels: ChannelTarget[]
    schedule: ScheduleConfig
    createdAt: string
    updatedAt: string
  }

  export interface DraftValidationResult {
    ok: boolean
    perChannel: Array<{
      channelId: string
      platform: SocialPlatform
      ok: boolean
      errors: Array<{ kind: string; field?: string; message: string }>
      warnings: Array<{ kind: string; field?: string; message: string }>
    }>
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit (frontend has no git, so just note)**

  Frontend is not a git repo — no commit. Move on.

---

## Task 14: Frontend API client

**Files:**
- Create: `src/features/composer/api/composer.api.ts`

- [ ] **Step 1: Write the client**

  Create `src/features/composer/api/composer.api.ts`:

  ```ts
  import { apiClient } from '@/lib/api'
  import type { Draft, DraftValidationResult } from '../types/draft.types'

  export interface UpdateDraftPayload {
    base?: Partial<Draft['base']>
    perPlatform?: Draft['perPlatform']
    channels?: Draft['channels']
    schedule?: Draft['schedule']
  }

  export const composerApi = {
    createDraft: (workspaceId: string) =>
      apiClient.post<Draft>(`/posts/workspaces/${workspaceId}/composer/drafts`, {}),

    listDrafts: (workspaceId: string, limit = 50) =>
      apiClient.get<Draft[]>(
        `/posts/workspaces/${workspaceId}/composer/drafts?limit=${limit}`,
      ),

    getDraft: (workspaceId: string, draftId: string) =>
      apiClient.get<Draft>(
        `/posts/workspaces/${workspaceId}/composer/drafts/${draftId}`,
      ),

    updateDraft: (workspaceId: string, draftId: string, payload: UpdateDraftPayload) =>
      apiClient.patch<Draft>(
        `/posts/workspaces/${workspaceId}/composer/drafts/${draftId}`,
        payload,
      ),

    deleteDraft: (workspaceId: string, draftId: string) =>
      apiClient.delete<{ success: true }>(
        `/posts/workspaces/${workspaceId}/composer/drafts/${draftId}`,
      ),

    validateDraft: (workspaceId: string, draftId: string) =>
      apiClient.post<DraftValidationResult>(
        `/posts/workspaces/${workspaceId}/composer/drafts/${draftId}/validate`,
        {},
      ),
  }
  ```

  **Verify** that `apiClient` has `.patch<T>(url, body)` in `@/lib/api`. If only `api()` is available:

  ```bash
  grep -n "apiClient\." src/lib/api.ts | head -10
  ```

  If `.patch` isn't on `apiClient`, fall back to `api(url, { method: 'PATCH', body: payload })` pattern.

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

---

## Task 15: queryKeys extension + React Query hooks

**Files:**
- Modify: `src/lib/query-client.ts`
- Create: `src/features/composer/hooks/use-draft.ts`
- Create: `src/features/composer/hooks/use-create-draft.ts`
- Create: `src/features/composer/hooks/use-update-draft.ts`

- [ ] **Step 1: Extend queryKeys**

  Open `src/lib/query-client.ts`. Add a `composer` key factory to the `queryKeys` object:

  ```ts
  // After channels block, add:
  composer: {
    drafts: (workspaceId: string) => ['composer', 'drafts', workspaceId] as const,
    draft: (workspaceId: string, draftId: string) =>
      ['composer', 'draft', workspaceId, draftId] as const,
  },
  ```

- [ ] **Step 2: Write use-draft hook**

  Create `src/features/composer/hooks/use-draft.ts`:

  ```ts
  import { useQuery } from '@tanstack/react-query'
  import { useWorkspaceId } from '@/hooks/use-workspace-id'
  import { queryKeys } from '@/lib/query-client'
  import { composerApi } from '../api/composer.api'

  export function useDraft(draftId: string | undefined) {
    const workspaceId = useWorkspaceId()
    return useQuery({
      queryKey:
        workspaceId && draftId
          ? queryKeys.composer.draft(workspaceId, draftId)
          : ['composer', 'draft', 'none'],
      queryFn: () => composerApi.getDraft(workspaceId as string, draftId as string),
      enabled: !!workspaceId && !!draftId,
      staleTime: 30 * 1000,
    })
  }
  ```

- [ ] **Step 3: Write use-create-draft hook**

  Create `src/features/composer/hooks/use-create-draft.ts`:

  ```ts
  import { useMutation, useQueryClient } from '@tanstack/react-query'
  import { toast } from 'sonner'
  import { useWorkspaceId } from '@/hooks/use-workspace-id'
  import { queryKeys } from '@/lib/query-client'
  import { composerApi } from '../api/composer.api'

  export function useCreateDraft() {
    const workspaceId = useWorkspaceId()
    const qc = useQueryClient()
    return useMutation({
      mutationFn: () => composerApi.createDraft(workspaceId as string),
      onSuccess: (draft) => {
        if (workspaceId) {
          qc.invalidateQueries({ queryKey: queryKeys.composer.drafts(workspaceId) })
          qc.setQueryData(queryKeys.composer.draft(workspaceId, draft.id), draft)
        }
      },
      onError: () => toast.error('Could not create draft. Please try again.'),
    })
  }
  ```

- [ ] **Step 4: Write use-update-draft hook (debounced auto-save)**

  Create `src/features/composer/hooks/use-update-draft.ts`:

  ```ts
  import { useEffect, useRef } from 'react'
  import { useMutation, useQueryClient } from '@tanstack/react-query'
  import { useWorkspaceId } from '@/hooks/use-workspace-id'
  import { queryKeys } from '@/lib/query-client'
  import { composerApi, type UpdateDraftPayload } from '../api/composer.api'
  import type { Draft } from '../types/draft.types'

  const AUTOSAVE_DEBOUNCE_MS = 800

  /** Debounced auto-save. Caller invokes save() on each change; we coalesce. */
  export function useUpdateDraft(draftId: string | undefined) {
    const workspaceId = useWorkspaceId()
    const qc = useQueryClient()
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingRef = useRef<UpdateDraftPayload | null>(null)

    const mutation = useMutation({
      mutationFn: (payload: UpdateDraftPayload) =>
        composerApi.updateDraft(workspaceId as string, draftId as string, payload),
      onSuccess: (draft: Draft) => {
        if (workspaceId && draftId) {
          qc.setQueryData(queryKeys.composer.draft(workspaceId, draftId), draft)
        }
      },
    })

    useEffect(() => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    function save(patch: UpdateDraftPayload) {
      if (!workspaceId || !draftId) return
      pendingRef.current = { ...(pendingRef.current ?? {}), ...patch }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        const payload = pendingRef.current
        pendingRef.current = null
        timerRef.current = null
        if (payload) mutation.mutate(payload)
      }, AUTOSAVE_DEBOUNCE_MS)
    }

    function flush() {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      const payload = pendingRef.current
      pendingRef.current = null
      if (payload) mutation.mutate(payload)
    }

    return {
      save,
      flush,
      isSaving: mutation.isPending,
      lastSavedAt: mutation.isSuccess ? new Date() : null,
      error: mutation.error,
    }
  }
  ```

- [ ] **Step 5: Verify build**

  ```bash
  npm run build
  ```

  Expected: PASS.

---

## Task 16: Composer page shell

**Files:**
- Create: `src/features/composer/pages/composer-page.tsx`

- [ ] **Step 1: Write the page shell**

  Create `src/features/composer/pages/composer-page.tsx`:

  ```tsx
  import { useEffect } from 'react'
  import { Navigate, useNavigate, useParams } from 'react-router'
  import { ArrowLeft, Loader2 } from 'lucide-react'
  import { Button } from '@/components/ui/button'
  import { Skeleton } from '@/components/ui/skeleton'
  import { useDraft } from '../hooks/use-draft'
  import { useCreateDraft } from '../hooks/use-create-draft'
  import { useWorkspaceId } from '@/hooks/use-workspace-id'
  import { wsPath } from '@/lib/workspace-path'

  /**
   * Phase 1: page shell only. No real composer UI yet — Phase 2 builds the
   * tabs, editor, preview pane, settings panels. This shell handles:
   *   - Route loads existing draft if :draftId present
   *   - If no draftId, creates a new draft and redirects to its URL
   *   - Shows loading skeleton during fetch
   *   - Renders a placeholder "coming soon" body
   */
  export function ComposerPage() {
    const { draftId } = useParams<{ draftId?: string }>()
    const workspaceId = useWorkspaceId()
    const navigate = useNavigate()
    const createDraft = useCreateDraft()
    const draft = useDraft(draftId)

    // Auto-create a draft if landing on /compose without :draftId
    useEffect(() => {
      if (!workspaceId || draftId) return
      if (createDraft.isPending || createDraft.isSuccess) return
      createDraft.mutate(undefined, {
        onSuccess: (newDraft) => {
          navigate(wsPath(workspaceId, `compose/${newDraft.id}`), { replace: true })
        },
      })
    }, [workspaceId, draftId, createDraft, navigate])

    if (!workspaceId) return <Navigate to="/" replace />

    if (!draftId || createDraft.isPending) {
      return (
        <div className="flex min-h-svh items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Creating a new draft…</p>
          </div>
        </div>
      )
    }

    if (draft.isLoading) {
      return (
        <div className="mx-auto max-w-6xl p-6">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-5 w-40" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-6">
            <Skeleton className="h-80 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        </div>
      )
    }

    if (draft.error || !draft.data) {
      return (
        <div className="flex min-h-svh items-center justify-center px-4 text-center">
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm font-medium text-destructive">Could not load this draft</p>
            <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
              Go back
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div className="mx-auto max-w-6xl p-6">
        <header className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5">
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <span className="text-xs text-muted-foreground">
            Draft <span className="font-mono">{draft.data.id.slice(0, 8)}</span>
          </span>
        </header>
        <div className="mt-6 rounded-lg border border-dashed border-border bg-background p-12 text-center">
          <h2 className="text-lg font-semibold">Composer UI lands in Phase 2</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground mx-auto">
            Phase 1 ships the foundation — draft data model, validators, capabilities. The
            tabbed editor, per-platform settings panels, and live preview ship in Phase 2.
          </p>
          <div className="mt-6 inline-flex flex-col items-start gap-1 rounded-md border border-border bg-muted/30 p-3 text-left text-xs text-muted-foreground">
            <span>Workspace: {draft.data.workspaceId}</span>
            <span>Channels selected: {draft.data.channels.length}</span>
            <span>Last updated: {new Date(draft.data.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

  Expected: PASS.

---

## Task 17: Router wiring

**Files:**
- Modify: `src/router.tsx`

- [ ] **Step 1: Read existing router**

  ```bash
  cat src/router.tsx
  ```

  Note the structure for workspace-scoped routes (e.g., the `/w/:workspaceId/...` block).

- [ ] **Step 2: Add the two composer routes**

  Add `ComposerPage` import:

  ```tsx
  import { ComposerPage } from '@/features/composer/pages/composer-page'
  ```

  In the workspace-scoped routes block, add (inside whichever wrapper requires auth + sidebar layout, per existing pattern):

  ```tsx
  {
    path: 'compose',
    element: <ComposerPage />,
  },
  {
    path: 'compose/:draftId',
    element: <ComposerPage />,
  },
  ```

  Match the existing route definition style (object form vs JSX form depending on what's used).

- [ ] **Step 3: Verify build + dev**

  ```bash
  npm run build
  npm run dev
  ```

  Open `http://localhost:5173/w/<wsId>/compose` (use a real workspaceId from your session). Expected:
  - Shows "Creating a new draft…" briefly
  - Redirects to `/w/<wsId>/compose/<draftId>`
  - Shows "Composer UI lands in Phase 2" placeholder card

  Stop dev server with Ctrl+C.

---

## Task 18: End-to-end smoke test

**Files:** none (validation only)

- [ ] **Step 1: Backend build + tests clean**

  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace"
  npm run build
  npx jest src/posts/composer --no-coverage
  ```

  Expected:
  - `npm run build` PASS
  - All composer specs PASS (PayloadResolver: 6, MediaValidator: 7, ComposerValidator: 6 — total ≥19)

- [ ] **Step 2: Manual API smoke test (backend dev server up)**

  Start backend if not running:

  ```bash
  npm run start:dev
  ```

  In another terminal, get a JWT (steal from frontend's `localStorage.accessToken` or use the auth endpoint):

  ```bash
  TOKEN="<paste your JWT here>"
  WS_ID="<your workspace id>"

  # Create draft
  curl -X POST "http://localhost:8000/posts/workspaces/$WS_ID/composer/drafts" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}'
  ```

  Expected response: a Draft object with `id` UUID, `status: 'draft'`, empty `base`, empty `channels`.

  Save the `id` as `DRAFT_ID`.

  ```bash
  # Update draft
  curl -X PATCH "http://localhost:8000/posts/workspaces/$WS_ID/composer/drafts/$DRAFT_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"base":{"text":"hello world from API"}}'

  # Get draft
  curl "http://localhost:8000/posts/workspaces/$WS_ID/composer/drafts/$DRAFT_ID" \
    -H "Authorization: Bearer $TOKEN"

  # Validate (should return ok:true since no channels selected → vacuous)
  curl -X POST "http://localhost:8000/posts/workspaces/$WS_ID/composer/drafts/$DRAFT_ID/validate" \
    -H "Authorization: Bearer $TOKEN"

  # Delete
  curl -X DELETE "http://localhost:8000/posts/workspaces/$WS_ID/composer/drafts/$DRAFT_ID" \
    -H "Authorization: Bearer $TOKEN"
  ```

  All 5 calls should return successful JSON responses.

  Stop server.

- [ ] **Step 3: Frontend dev smoke test**

  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend"
  npm run dev
  ```

  Open `http://localhost:5173/w/<wsId>/compose` in browser. Verify:
  - Page loads
  - Brief "Creating a new draft…" spinner
  - URL updates to `/w/<wsId>/compose/<uuid>`
  - Placeholder card renders showing draft id + workspace id

  Stop dev server.

- [ ] **Step 4: Final commit + tag**

  ```bash
  cd "d:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace"
  git tag -a phase-1-post-composer-foundation -m "Phase 1 of post composer complete

Includes:
- L1 Compose Engine: Draft + BaseContent + PlatformOverrides + sparse inheritance
- L2 Capability Registry: ComposerCapabilities extended for all 10 platforms
- L3 Media Validation: per-platform constraint checks
- ComposerService: draft CRUD against existing posts table (no migration)
- ComposerController: 7 endpoints (CRUD + validate + preview-payload)
- PayloadResolverService: Draft + Channel → PublicationPayload (TDD'd)
- ComposerValidatorService: char limits + required fields + media (TDD'd)
- Frontend: page shell + auto-save hook + draft fetching

Test count: 19 passing across 3 specs.

Phase 2 adds: TipTap editor, tabs UI, platform-grouped channel chips,
preview panes, Twitter publisher integration."
  ```

---

## Self-review checklist

After completing all 18 tasks above, verify against the spec (`docs/specs/2026-05-17-post-composer-design.md`):

- ✅ L1 Compose Engine — Draft + BaseContent + PlatformOverrides types defined
- ✅ Sparse override inheritance via `PayloadResolverService.resolve` (verified by tests)
- ✅ L2 Capability Registry — ComposerCapabilities populated for all 10 platforms
- ✅ L3 Media Pipeline (validation) — MediaValidatorService with per-platform constraint checks
- ✅ Backend draft endpoints (7) — controller + service + module wired
- ✅ Uses existing `posts` table — no schema migration
- ✅ Frontend page shell with auto-save hook
- ✅ Route registered (compose / compose/:draftId)

**Deferred to Phase 2:**
- TipTap editor
- Tabs UI (Original + platform-grouped tabs)
- Preview Renderers
- Per-platform settings panels
- Twitter publishing integration
- WebSocket for per-channel publish status

**Deferred to later phases:**
- Media auto-transform (Phase 4)
- AI patch pipeline (Phase 4)
- Drafts list page (Phase 4)
- Plugin architecture / cross-platform adaptation / mobile (Phase 5+)

---

## Phase 1 success criteria

- ✅ TypeScript compiles cleanly on both repos
- ✅ All 3 service specs pass (≥19 tests)
- ✅ All 7 endpoints register and respond
- ✅ Manual API smoke test creates, fetches, updates, validates, deletes a draft
- ✅ Frontend route renders, creates new draft, redirects to id-scoped URL
- ✅ Tag `phase-1-post-composer-foundation` exists
