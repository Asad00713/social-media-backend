import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * DELETE /users/me: the person types their own email to confirm. Not
 * `@IsEmail`: any string is compared (trimmed and lowercased on both sides)
 * and a mismatch is the 400 `EMAIL_MISMATCH` the dialog shows, rather than a
 * generic validation error. 320 is the longest possible address.
 *
 * With two-step sign-in on, a second factor too (R13): `code` takes a
 * 6-digit TOTP **or** a backup code in any shape (one field is what the
 * dialog sends); `backupCode` is also accepted. Sending both is refused.
 */
export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  confirmEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  backupCode?: string;
}
