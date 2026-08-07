import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  /**
   * Issued by `POST /auth/admin/verify` after an emailed code is accepted.
   * Optional on the DTO because ordinary users never send one — but the login
   * path requires it for SUPER_ADMIN accounts, so it is optional to the
   * validator and mandatory to the rule.
   */
  @IsString()
  @IsOptional()
  challengeToken?: string;
}
