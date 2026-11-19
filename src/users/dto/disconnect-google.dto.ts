import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * POST /users/me/google/disconnect: the password confirms it is the owner of
 * the account, not a stolen session, removing a way to sign in. Required (no
 * `@IsOptional`, so null and a missing key both fail) and never trimmed: a
 * password may begin or end with a space. 128 is the cap register and reset
 * enforce, so a longer value cannot be a real password.
 */
export class DisconnectGoogleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;
}
