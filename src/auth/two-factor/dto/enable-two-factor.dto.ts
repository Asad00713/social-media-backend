import { IsString, Matches } from 'class-validator';

/** `POST /users/me/2fa/enable`: the first code from the newly added app. */
export class EnableTwoFactorDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code: string;
}
