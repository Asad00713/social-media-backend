import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * `POST /auth/2fa/verify`. Exactly one of `code` / `backupCode` is enforced
 * by SecondFactorService.check (MFA_CODE_REQUIRED), not here, so the answer
 * is the coded error the sign-in screen knows rather than a validation 400.
 */
export class VerifyTwoFactorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  challengeToken: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  backupCode?: string;
}
