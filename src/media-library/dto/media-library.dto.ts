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
}

export class MediaItemQueryDto {
  @IsOptional()
  @IsEnum(['image', 'video', 'gif', 'document'])
  type?: 'image' | 'video' | 'gif' | 'document';

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
}

export class BulkActionDto {
  @IsArray()
  @IsUUID('all', { each: true })
  ids: string[];

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
