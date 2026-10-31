import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsUrl,
  IsObject,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ValidateIf,
  IsIn,
  IsISO8601,
  ArrayMaxSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  MEDIA_LIBRARY_TYPES,
  TEMPLATE_TYPES,
  TEXT_SNIPPET_TYPES,
} from '../../drizzle/schema/media-library.schema';
import {
  FOLDER_KINDS,
  normalizeFolderKind,
  normalizeSnippetType,
  type FolderKind,
} from '../lib/folder-kind';
import { RATIOS } from '../lib/ratio';
import type { MediaSort, Ratio } from './contract';

const MEDIA_SORTS = [
  'newest',
  'oldest',
  'most_used',
  'recently_used',
  'name',
  'size',
] as const satisfies readonly MediaSort[];

/** Templates and snippets sort like media, minus `size` (ruling 7). */
const KIND_SORTS = [
  'newest',
  'oldest',
  'most_used',
  'recently_used',
  'name',
] as const;
export type KindSort = (typeof KIND_SORTS)[number];

/** The actions templates, snippets and links accept in bulk (ruling 6). */
const KIND_BULK_ACTIONS = ['delete', 'star', 'unstar', 'move'] as const;
export type KindBulkAction = (typeof KIND_BULK_ACTIONS)[number];

/** Query-string booleans: only 'true' (or a JSON true) is true. */
const toBool = ({ value }: { value: unknown }) =>
  value === 'true' || value === true;

// Re-define types locally to avoid decorator issues
type MediaLibraryType = (typeof MEDIA_LIBRARY_TYPES)[number];
type TemplateType = (typeof TEMPLATE_TYPES)[number];
type TextSnippetType = (typeof TEXT_SNIPPET_TYPES)[number];

// =============================================================================
// Category DTOs
// =============================================================================

export class CreateCategoryDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  // A folder belongs to exactly one kind — required at creation. Legacy
  // image|video|gif|document are accepted and stored as 'media'.
  @Transform(({ value }) => normalizeFolderKind(value))
  @IsIn(FOLDER_KINDS)
  type: FolderKind;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  // Accepted so the contract's PUT body validates, but a folder's kind can't
  // change: the service rejects a kind different from the current one.
  @IsOptional()
  @Transform(({ value }) => normalizeFolderKind(value))
  @IsIn(FOLDER_KINDS)
  type?: FolderKind;
}

export class CategoryQueryDto {
  @IsOptional()
  @Transform(({ value }) => normalizeFolderKind(value))
  @IsIn(FOLDER_KINDS)
  type?: FolderKind;

  // Adds each folder's item count, bytes and up to 4 cover URLs (one query).
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  withStats?: boolean;

  // Case-insensitive match on the folder name.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ReorderCategoriesDto {
  @Transform(({ value }) => normalizeFolderKind(value))
  @IsIn(FOLDER_KINDS)
  type: FolderKind;

  @IsArray()
  @IsUUID('all', { each: true })
  categoryIds: string[];
}

// =============================================================================
// Media Item DTOs
// =============================================================================

export class CreateMediaItemDto {
  @IsEnum(['image', 'video', 'gif', 'document'])
  type: 'image' | 'video' | 'gif' | 'document';

  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @IsOptional()
  @IsInt()
  fileSize?: number;

  @IsOptional()
  @IsInt()
  width?: number;

  @IsOptional()
  @IsInt()
  height?: number;

  @IsOptional()
  @IsInt()
  duration?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  cloudinaryPublicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  cloudinaryAssetId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  altText?: string;

  // PDFs only.
  @IsOptional()
  @IsInt()
  @Min(1)
  pageCount?: number;
}

export class UpdateMediaItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  // `null` is meaningful here: it takes the item out of its folder. Only a
  // non-null value is checked as a UUID, so "unfile" stays expressible —
  // omitting the field still means "leave the folder as it is".
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;

  // `null` clears the alt text; omitting it leaves it as it is.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  altText?: string | null;
}

export class MediaItemQueryDto {
  // `images` is image + gif.
  @IsOptional()
  @IsIn(['image', 'video', 'gif', 'document', 'images'])
  type?: 'image' | 'video' | 'gif' | 'document' | 'images';

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isStarred?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isDeleted?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value, 10))
  offset?: number;

  @IsOptional()
  @IsEnum(['createdAt', 'name', 'usageCount', 'lastUsedAt'])
  sortBy?: 'createdAt' | 'name' | 'usageCount' | 'lastUsedAt';

  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  // Contract names. `starred` wins over the legacy `isStarred`, and `sort`
  // wins over `sortBy`/`sortOrder`.
  @IsOptional()
  @IsBoolean()
  @Transform(toBool)
  starred?: boolean;

  /** The `/usage` reference test, with zero hits. */
  @IsOptional()
  @IsBoolean()
  @Transform(toBool)
  neverUsed?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(toBool)
  gifOnly?: boolean;

  @IsOptional()
  @IsIn(RATIOS)
  ratio?: Ratio;

  // Strict rejects impossible dates (2026-02-30). ISO forms Date cannot
  // parse (week or ordinal dates) are refused by the service with a 400.
  @IsOptional()
  @IsISO8601({ strict: true })
  addedSince?: string;

  @IsOptional()
  @IsUUID()
  uploadedBy?: string;

  @IsOptional()
  @IsIn(MEDIA_SORTS)
  sort?: MediaSort;
}

/** Runs a bulk action on every item the list's filter matches. */
export class BulkSelectAllDto {
  @ValidateNested()
  @Type(() => MediaItemQueryDto)
  filter: MediaItemQueryDto;
}

export class BulkActionDto {
  // Exactly one of `ids` and `selectAll` (the service answers 400 otherwise).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => BulkSelectAllDto)
  selectAll?: BulkSelectAllDto;

  @IsEnum(['delete', 'restore', 'move', 'star', 'unstar', 'permanentDelete'])
  action: 'delete' | 'restore' | 'move' | 'star' | 'unstar' | 'permanentDelete';

  // Only `move` reads this, and there `null` is a real instruction: take the
  // selection out of its folders. Mirrors UpdateMediaItemDto so one item and a
  // hundred can express the same thing — omit to leave folders alone, pass
  // null to unfile, pass an id to file.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null; // For move action
}

// =============================================================================
// Template DTOs
// =============================================================================

export class TemplateMediaSlotDto {
  @IsString()
  id: string;

  @IsString()
  label: string;

  @IsBoolean()
  required: boolean;

  @IsArray()
  @IsEnum(['image', 'video', 'gif'], { each: true })
  acceptedTypes: ('image' | 'video' | 'gif')[];
}

/**
 * An asset saved into the template itself. Mirrors the composer's media item so
 * applying a template is a copy, not a translation.
 */
export class TemplateMediaDto {
  @IsString()
  id: string;

  @IsEnum(['image', 'video', 'gif'])
  type: 'image' | 'video' | 'gif';

  @IsUrl({ require_tld: false })
  url: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  thumbnailUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  height?: number;

  // Seconds. Integer to match how durations are stored everywhere else here —
  // browsers report a float, so callers round before sending.
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSec?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;
}

export class TemplateContentDto {
  @IsString()
  text: string;

  // Optional so a template that only bakes in media doesn't have to send an
  // empty array to satisfy a field it never uses.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateMediaSlotDto)
  mediaSlots?: TemplateMediaSlotDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateMediaDto)
  media?: TemplateMediaDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hashtags?: string[];

  @IsOptional()
  @IsString()
  defaultCaption?: string;
}

export class CreateTemplateDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(TEMPLATE_TYPES)
  templateType: TemplateType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  @IsObject()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content: TemplateContentDto;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TEMPLATE_TYPES)
  templateType?: TemplateType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content?: TemplateContentDto;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;
}

export class TemplateQueryDto {
  @IsOptional()
  @IsEnum(TEMPLATE_TYPES)
  templateType?: TemplateType;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isStarred?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isDeleted?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value, 10))
  offset?: number;

  // Contract name; wins over the legacy `isStarred`.
  @IsOptional()
  @IsBoolean()
  @Transform(toBool)
  starred?: boolean;

  @IsOptional()
  @IsIn(KIND_SORTS)
  sort?: KindSort;
}

export class TemplateSelectAllDto {
  @ValidateNested()
  @Type(() => TemplateQueryDto)
  filter: TemplateQueryDto;
}

export class TemplateBulkDto {
  // Exactly one of `ids` and `selectAll` (the service answers 400 otherwise).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateSelectAllDto)
  selectAll?: TemplateSelectAllDto;

  @IsIn(KIND_BULK_ACTIONS)
  action: KindBulkAction;

  // `move` only: null unfiles, an id files, omitted is a 400 (X1).
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;
}

// =============================================================================
// Text Snippet DTOs
// =============================================================================

export class CreateTextSnippetDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @Transform(({ value }) => normalizeSnippetType(value))
  @IsIn(TEXT_SNIPPET_TYPES)
  snippetType: TextSnippetType;

  @IsString()
  content: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateTextSnippetDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSnippetType(value))
  @IsIn(TEXT_SNIPPET_TYPES)
  snippetType?: TextSnippetType;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;
}

export class TextSnippetQueryDto {
  // Contract name. Wins over the legacy `snippetType` when both are sent.
  @IsOptional()
  @Transform(({ value }) => normalizeSnippetType(value))
  @IsIn(TEXT_SNIPPET_TYPES)
  type?: TextSnippetType;

  @IsOptional()
  @Transform(({ value }) => normalizeSnippetType(value))
  @IsIn(TEXT_SNIPPET_TYPES)
  snippetType?: TextSnippetType;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isStarred?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isDeleted?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value, 10))
  offset?: number;

  // Contract name; wins over the legacy `isStarred`.
  @IsOptional()
  @IsBoolean()
  @Transform(toBool)
  starred?: boolean;

  @IsOptional()
  @IsIn(KIND_SORTS)
  sort?: KindSort;
}

export class SnippetSelectAllDto {
  @ValidateNested()
  @Type(() => TextSnippetQueryDto)
  filter: TextSnippetQueryDto;
}

export class SnippetBulkDto {
  // Exactly one of `ids` and `selectAll` (the service answers 400 otherwise).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SnippetSelectAllDto)
  selectAll?: SnippetSelectAllDto;

  @IsIn(KIND_BULK_ACTIONS)
  action: KindBulkAction;

  // `move` only: null unfiles, an id files, omitted is a 400 (X1).
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;
}

// =============================================================================
// Saved Link DTOs
// =============================================================================

export class UtmDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  medium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  campaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  term?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  content?: string;
}

export class CreateSavedLinkDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsUrl()
  url: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => UtmDto)
  utm?: UtmDto;
}

export class UpdateSavedLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;

  /** null clears the UTM tags. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @ValidateNested()
  @Type(() => UtmDto)
  utm?: UtmDto | null;
}

export class SavedLinkQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isStarred?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isDeleted?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['newest', 'most_used', 'name'])
  sort?: 'newest' | 'most_used' | 'name';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value, 10))
  offset?: number;
}

export class LinkSelectAllDto {
  @ValidateNested()
  @Type(() => SavedLinkQueryDto)
  filter: SavedLinkQueryDto;
}

export class LinkBulkDto {
  // Exactly one of `ids` and `selectAll` (the service answers 400 otherwise).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LinkSelectAllDto)
  selectAll?: LinkSelectAllDto;

  @IsIn(KIND_BULK_ACTIONS)
  action: KindBulkAction;

  // `move` only: null unfiles, an id files, omitted is a 400 (X1).
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;
}

// =============================================================================
// Recycle Bin DTOs
// =============================================================================

export class RecycleBinQueryDto {
  @IsOptional()
  @IsEnum(MEDIA_LIBRARY_TYPES)
  type?: MediaLibraryType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value, 10))
  offset?: number;
}
