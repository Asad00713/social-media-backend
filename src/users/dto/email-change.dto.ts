import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** POST /users/me/email-change (spec Appendix A.2). */
export class RequestEmailChangeDto {
  /** Normalised by the service; trimmed here so ` Me@X.com ` validates. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(255)
  newEmail: string;

  /** Required when the account has a password; the service says so (400). */
  @IsString()
  @IsOptional()
  currentPassword?: string;
}

/** POST /users/me/email-change/confirm: six digits, spaces allowed (`305 771`). */
export class ConfirmEmailChangeDto {
  @IsString()
  @Matches(/^\s*(\d\s*){6}$/, { message: 'Enter the 6-digit code.' })
  code: string;
}
