import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * DELETE /users/me: the person types their own email to confirm. Not
 * `@IsEmail`: any string is compared (trimmed and lowercased on both sides)
 * and a mismatch is the 400 `EMAIL_MISMATCH` the dialog shows, rather than a
 * generic validation error. 320 is the longest possible address.
 */
export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  confirmEmail: string;
}
