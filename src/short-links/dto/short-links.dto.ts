import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { CODES_FILTER_MAX, CODE_PATTERN } from '../short-link-rules';

export class CreateShortLinkDto {
  /**
   * The address to shorten. Only shape-checked here (a string, bounded);
   * `checkTargetUrl` decides whether it is allowed and normalises it, so the
   * message names the actual problem.
   */
  @IsString()
  @MaxLength(4096)
  url!: string;

  /** The saved draft this link is for, when there is one. */
  @IsOptional()
  @IsUUID()
  postId?: string;
}

export class ListShortLinksQueryDto {
  @IsOptional()
  @IsUUID()
  postId?: string;

  /** `?codes=a1B2c3D,x9Y8z7W` — only these codes. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(CODES_FILTER_MAX)
  @IsString({ each: true })
  @Matches(CODE_PATTERN, { each: true })
  codes?: string[];
}

/** One short link as the API returns it. */
export interface ShortLinkDto {
  id: string;
  code: string;
  shortUrl: string;
  targetUrl: string;
  postId: string | null;
  clicks: number;
  lastClickedAt: string | null;
  createdAt: string;
}

/** The list, with the base so a client can recognise its short URLs. */
export interface ShortLinkListDto {
  /** Null when this server has no public URL to put short links under. */
  baseUrl: string | null;
  links: ShortLinkDto[];
}
