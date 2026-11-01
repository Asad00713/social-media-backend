/**
 * Library API contract types, copied verbatim from
 * `docs/superpowers/specs/2026-10-31-library-api-contract.md` (frontend repo).
 * The frontend copies the same shapes, so a change starts in the contract.
 *
 * Types that already have a home (D16) are re-exported, not duplicated:
 * `FolderKind`/`MediaType` from `lib/folder-kind.ts`, `StorageProvider` and
 * `SavedLinkUtm` from the Drizzle schema.
 */
export type { FolderKind, MediaType } from '../lib/folder-kind';
export type {
  StorageProvider,
  SavedLinkUtm,
} from '../../drizzle/schema/media-library.schema';

export type SnippetType =
  | 'caption'
  | 'hashtags'
  | 'cta'
  | 'signature'
  | 'other'; // bio → signature

/** Runtime list of `BinKind` values, for validation (B11). */
export const BIN_KINDS = ['media', 'template', 'snippet', 'link'] as const;
export type BinKind = (typeof BIN_KINDS)[number];

export type Ratio = '1:1' | '4:5' | '9:16' | '16:9';
export type MediaSort =
  | 'newest'
  | 'oldest' // added 2026-10-31 (owner, Figma 09)
  | 'most_used'
  | 'recently_used'
  | 'name'
  | 'size';

export interface UserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** One place a media item is used, for `GET items/:id/usage`. */
export interface UsageEntry {
  kind: 'post' | 'campaign_slot';
  id: string;
  campaignId: string | null; // the slot's campaign, so a campaign_slot row can link; null for posts (amended 2026-11-01)
  title: string; // the post's first line, or the campaign name
  platform: string; // e.g. 'instagram'
  date: string; // scheduled or published time
  status: 'draft' | 'scheduled' | 'published' | 'failed';
}

export interface LibraryStats {
  storage: {
    used: number; // all media_items.file_size, Bin included
    limit: number; // effective: storage_bytes_limit + extra_storage_purchased
    percent: number; // 0–100, one decimal
    level: 'ok' | 'almost_full' | 'full'; // almost_full at >= 90%, full at >= 100%
    byType: { images: number; videos: number; docs: number }; // bytes, not deleted
  };
  unused: { count: number; bytes: number }; // not deleted, never used
  bin: { count: number; bytes: number }; // all four kinds; bytes from media only
  counts: {
    media: { all: number; images: number; videos: number; docs: number };
    templates: {
      all: number;
      post: number;
      story: number;
      reel: number;
      carousel: number;
    };
    snippets: {
      all: number;
      caption: number;
      hashtags: number;
      cta: number;
      signature: number;
    };
    links: number;
    folders: {
      media: number;
      template: number;
      text_snippet: number;
      link: number;
    };
  };
}

/** `GET categories?withStats=true` adds this to each folder. */
export interface FolderStats {
  itemCount: number;
  bytes: number;
  covers: string[]; // up to 4 thumbnail URLs, newest first
}

/**
 * 413 from every upload entry point and from saving an item, when the file
 * would take the workspace over its storage limit.
 */
export interface StorageFullError {
  code: 'STORAGE_FULL';
  message: string;
  used: number;
  limit: number;
}

/** 400 from `POST items`: the directly uploaded object is not there yet. */
export interface UploadNotFinishedError {
  code: 'UPLOAD_NOT_FINISHED';
  message: string;
}

/** 503 from `POST items`: the store could not report the size; retryable. */
export interface SizeUnavailableError {
  code: 'SIZE_UNAVAILABLE';
  message: string;
}

/** 409 from the server upload routes: the target already existed. */
export interface UploadConflictError {
  code: 'UPLOAD_CONFLICT';
  message: string;
}

/** 413 from `GET categories/:id/zip` when the folder is over 2 GB. */
export interface ZipTooLargeError {
  code: 'ZIP_TOO_LARGE';
  message: string;
}

/** 422 from `POST items/:id/alt-text` for anything that is not an image. */
export interface NotAnImageError {
  code: 'NOT_AN_IMAGE';
  message: string;
}

/** 402 from `POST items/:id/alt-text` when the workspace is out of AI tokens. */
export interface AiTokensExhaustedError {
  code: 'AI_TOKENS_EXHAUSTED';
  message: string;
}

export interface BinRow {
  kind: BinKind;
  id: string;
  name: string;
  thumbnailUrl: string | null;
  type: string; // 'image' | 'video' | 'gif' | 'document' | 'template' | 'snippet' | 'link'
  sizeBytes: number | null; // media only
  deletedAt: string;
  deletedBy: UserRef | null;
  purgeAt: string; // deletedAt + 30 days
}
