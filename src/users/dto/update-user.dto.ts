import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import {
  USER_USE_CASES,
  type UserUseCase,
} from '../../drizzle/schema/users.schema';

export class UpdateUserDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password?: string;

  /** Who the person posts for — onboarding step 1. */
  @IsIn(USER_USE_CASES)
  @IsOptional()
  useCase?: UserUseCase;
}
