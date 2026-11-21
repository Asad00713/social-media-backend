import { IsOptional, IsString, MaxLength } from 'class-validator';

/** `POST /users/me/2fa/setup`. The password is required when the account has one. */
export class SetupTwoFactorDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
