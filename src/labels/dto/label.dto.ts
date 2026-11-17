import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  LABEL_COLORS,
  LABEL_DESCRIPTION_MAX,
  LABEL_NAME_MAX,
  type LabelColor,
} from '../../drizzle/schema/labels.schema';

/**
 * A label name the way the catalogue stores it: inner whitespace collapsed
 * to one space, then trimmed (the same rule as the composer's
 * `normaliseLabels` and the 0090 backfill). Non-strings pass through so
 * `@IsString` rejects them.
 */
const normaliseName = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// `@IsOptional()` would also wave `null` through; these fields may be left
// out but never sent as null, so only `undefined` skips validation.
const present = (_o: unknown, v: unknown): boolean => v !== undefined;

export class CreateLabelDto {
  @Transform(normaliseName)
  @IsString()
  @Length(1, LABEL_NAME_MAX)
  name!: string;

  /** Omitted: the server picks the next palette colour (`nextColor`). */
  @ValidateIf(present)
  @IsIn(LABEL_COLORS)
  color?: LabelColor;

  @ValidateIf(present)
  @Transform(trimString)
  @IsString()
  @MaxLength(LABEL_DESCRIPTION_MAX)
  description?: string;
}

export class UpdateLabelDto {
  @ValidateIf(present)
  @Transform(normaliseName)
  @IsString()
  @Length(1, LABEL_NAME_MAX)
  name?: string;

  @ValidateIf(present)
  @IsIn(LABEL_COLORS)
  color?: LabelColor;

  /** `null` clears the description; `undefined` leaves it unchanged. */
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined && v !== null)
  @Transform(trimString)
  @IsString()
  @MaxLength(LABEL_DESCRIPTION_MAX)
  description?: string | null;
}

export class MergeLabelDto {
  @IsUUID()
  intoId!: string;
}

/** One catalogue label as the API returns it (spec §5.9). */
export interface Label {
  id: string;
  name: string;
  color: LabelColor;
  description: string | null;
  /** post_labels rows on this label. */
  postCount: number;
  /** ISO time of the newest post_labels row; null when never used. */
  lastUsedAt: string | null;
}

export interface LabelList {
  labels: Label[];
  total: number;
}
