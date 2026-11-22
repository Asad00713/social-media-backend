import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * `POST /users/me/2fa/backup-codes/regenerate` and `POST /users/me/2fa/disable`.
 * Exactly one of `code` / `backupCode` is enforced by SecondFactorService
 * (MFA_CODE_REQUIRED). `currentPassword` is read by disable only, and is
 * required there when the account has a password.
 */
export class SecondFactorDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  backupCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
