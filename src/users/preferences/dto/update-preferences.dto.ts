import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { IsIanaTimeZone } from '../../../common/validators/is-iana-time-zone';
import {
  COMPOSER_DEFAULT_WHEN,
  DATE_FORMATS,
  HIDEABLE_MODULES,
  LANGUAGES,
  START_PAGES,
  THEMES,
  TIME_FORMATS,
  WEEK_STARTS,
  type UserPreferences,
} from '../user-preferences';

/**
 * Any subset of the preferences (spec 5.4). Unknown keys are rejected by the
 * global ValidationPipe (`forbidNonWhitelisted`), not silently stripped.
 */
export class UpdatePreferencesDto implements Partial<UserPreferences> {
  @IsOptional()
  @IsIn(THEMES)
  theme?: UserPreferences['theme'];

  @IsOptional()
  @IsIn(LANGUAGES)
  language?: UserPreferences['language'];

  /** null = follow the device (stored); undefined = leave unchanged. */
  @ValidateIf(
    (o: UpdatePreferencesDto) =>
      o.timezone !== undefined && o.timezone !== null,
  )
  @IsIanaTimeZone()
  timezone?: string | null;

  @IsOptional()
  @IsIn(TIME_FORMATS)
  timeFormat?: UserPreferences['timeFormat'];

  @IsOptional()
  @IsIn(WEEK_STARTS)
  weekStart?: UserPreferences['weekStart'];

  @IsOptional()
  @IsIn(DATE_FORMATS)
  dateFormat?: UserPreferences['dateFormat'];

  @IsOptional()
  @IsIn(START_PAGES)
  startPage?: UserPreferences['startPage'];

  // Deduped before validation, so the size cap counts distinct modules.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? [...new Set(value)] : value,
  )
  @IsArray()
  @ArrayMaxSize(HIDEABLE_MODULES.length)
  @IsIn(HIDEABLE_MODULES, { each: true })
  hiddenModules?: UserPreferences['hiddenModules'];

  @IsOptional()
  @IsIn(COMPOSER_DEFAULT_WHEN)
  composerDefaultWhen?: UserPreferences['composerDefaultWhen'];
}
