import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class RequestAdminChallengeDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class VerifyAdminChallengeDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'The code is 6 digits' })
  otp: string;
}
