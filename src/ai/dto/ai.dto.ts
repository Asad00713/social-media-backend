import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';

// Platform and tone enums
export const PLATFORMS = [
  'twitter',
  'linkedin',
  'facebook',
  'instagram',
  'threads',
  'pinterest',
  'youtube',
] as const;

export const TONES = [
  'professional',
  'casual',
  'humorous',
  'inspirational',
  'educational',
  'promotional',
  'storytelling',
  'urgent',
  'conversational',
  'authoritative',
] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Tone = (typeof TONES)[number];

// =============================================================================
// Generate Post DTO
// =============================================================================

export class GeneratePostDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  topic: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsEnum(TONES)
  @IsOptional()
  tone?: Tone;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  additionalContext?: string;
}

// =============================================================================
// Generate Caption DTO
// =============================================================================

export class GenerateCaptionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsEnum(TONES)
  @IsOptional()
  tone?: Tone;

  @IsOptional()
  includeHashtags?: boolean;

  @IsOptional()
  includeCta?: boolean;
}

// =============================================================================
// Generate Hashtags DTO
// =============================================================================

export class GenerateHashtagsDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  topic: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(30)
  count?: number;
}

// =============================================================================
// Generate Ideas DTO
// =============================================================================

export class GenerateIdeasDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  niche: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(20)
  count?: number;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  contentType?: string;
}

// =============================================================================
// Generate YouTube Metadata DTO
// =============================================================================

export class GenerateYouTubeMetadataDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  videoDescription: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  targetAudience?: string;
}

// =============================================================================
// Repurpose Content DTO
// =============================================================================

export class RepurposeContentDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  originalContent: string;

  @IsEnum(PLATFORMS)
  sourcePlatform: Platform;

  @IsEnum(PLATFORMS)
  targetPlatform: Platform;
}

// =============================================================================
// Improve Post DTO
// =============================================================================

export class ImprovePostDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  originalPost: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  improvementFocus?: string;
}

// =============================================================================
// Generate Thread DTO
// =============================================================================

export class GenerateThreadDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  topic: string;

  @IsEnum(['twitter', 'threads'])
  platform: 'twitter' | 'threads';

  @IsNumber()
  @IsOptional()
  @Min(2)
  @Max(25)
  postCount?: number;
}

// =============================================================================
// Generate Bio DTO
// =============================================================================

export class GenerateBioDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsArray()
  @IsOptional()
  keywords?: string[];
}

// =============================================================================
// Translate Content DTO
// =============================================================================

export class TranslateContentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  targetLanguage: string;

  @IsEnum(PLATFORMS)
  @IsOptional()
  platform?: Platform;
}

// =============================================================================
// Generate Variations DTO
// =============================================================================

export class GenerateVariationsDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  content: string;

  @IsEnum(PLATFORMS)
  platform: Platform;

  @IsNumber()
  @IsOptional()
  @Min(2)
  @Max(10)
  count?: number;
}

// =============================================================================
// Analyze Post DTO
// =============================================================================

export class AnalyzePostDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  content: string;

  @IsEnum(PLATFORMS)
  platform: Platform;
}

// =============================================================================
// Response DTOs
// =============================================================================

export class GeneratedContentResponseDto {
  content: string;
}

export class GeneratedHashtagsResponseDto {
  hashtags: string[];
}

export class ContentIdeaResponseDto {
  title: string;
  description: string;
  format: string;
}

export class GeneratedIdeasResponseDto {
  ideas: ContentIdeaResponseDto[];
}

export class YouTubeMetadataResponseDto {
  title: string;
  description: string;
  tags: string[];
}

export class GeneratedThreadResponseDto {
  posts: string[];
}

export class GeneratedVariationsResponseDto {
  variations: string[];
}

export class PostAnalysisResponseDto {
  score: number;
  strengths: string[];
  improvements: string[];
  suggestions: string;
}

export class AiStatusResponseDto {
  configured: boolean;
  message: string;
  model: string;
}
