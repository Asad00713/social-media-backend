import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { IsIanaTimeZone } from 'src/common/validators/is-iana-time-zone';
import { APPROVAL_POLICIES, type ApprovalPolicy } from 'src/drizzle/schema';

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty({ message: 'Workspace name cannot be empty' })
  @MinLength(1, { message: 'Workspace name must be at least 1 character' })
  @MaxLength(40, { message: 'Workspace name must not exceed 40 characters' })
  @Transform(({ value }) => value?.trim())
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: 'Description must not exceed 500 characters' })
  description?: string;

  /**
   * `null` clears the logo. A URL must be a file `workspace-logo` presign
   * issued; the service refuses any other with `LOGO_NOT_UPLOADED`.
   */
  @ValidateIf(
    (o: UpdateWorkspaceDto) => o.logo !== null && o.logo !== undefined,
  )
  @IsString()
  @IsUrl({}, { message: 'Logo must be a valid URL' })
  logo?: string | null;

  // Not IsOptional: it also skips null, and a null zone would reach a NOT NULL
  // column as a 500. The same goes for the three publishing defaults below.
  @ValidateIf((o: UpdateWorkspaceDto) => o.timezone !== undefined)
  @IsString()
  @IsIanaTimeZone()
  timezone?: string;

  /**
   * Also move the workspace's channels to the new zone. Only meaningful with
   * `timezone`; the service answers 400 `TIMEZONE_REQUIRED` without it.
   */
  @ValidateIf(
    (o: UpdateWorkspaceDto) => o.applyTimezoneToChannels !== undefined,
  )
  @IsBoolean()
  applyTimezoneToChannels?: boolean;

  @ValidateIf((o: UpdateWorkspaceDto) => o.approvalPolicy !== undefined)
  @IsIn(APPROVAL_POLICIES as unknown as string[], {
    message: 'approvalPolicy must be one of: none, members, everyone',
  })
  approvalPolicy?: ApprovalPolicy;

  @ValidateIf((o: UpdateWorkspaceDto) => o.shortenLinksDefault !== undefined)
  @IsBoolean()
  shortenLinksDefault?: boolean;

  @ValidateIf((o: UpdateWorkspaceDto) => o.utmDefault !== undefined)
  @IsBoolean()
  utmDefault?: boolean;
}
