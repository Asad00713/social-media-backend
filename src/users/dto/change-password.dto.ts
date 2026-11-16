import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** POST /users/me/password (spec Appendix A.3). */
export class ChangePasswordDto {
  /** Required when the account has a password; the service says so (400). */
  @IsString()
  @IsOptional()
  currentPassword?: string;

  // The same rule as register and reset (auth/dto/reset-password.dto.ts).
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password is too long' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, and one number',
  })
  newPassword: string;
}
