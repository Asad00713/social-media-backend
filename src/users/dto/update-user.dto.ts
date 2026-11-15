import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  USER_USE_CASES,
  type UserUseCase,
} from '../../drizzle/schema/users.schema';

export class UpdateUserDto {
  /**
   * Accepted only so the whitelist keeps it: UsersService.update answers
   * USE_EMAIL_CHANGE_FLOW instead of silently dropping it.
   */
  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  name?: string;

  /** Accepted only to be refused with USE_PASSWORD_CHANGE_FLOW, as `email`. */
  @IsString()
  @IsOptional()
  password?: string;

  /** Who the person posts for — onboarding step 1. */
  @IsIn(USER_USE_CASES)
  @IsOptional()
  useCase?: UserUseCase;
}
