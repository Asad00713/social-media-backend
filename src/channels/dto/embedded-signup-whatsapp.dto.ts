import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class EmbeddedSignupWhatsAppDto {
  // Short-lived exchangeable code from the Embedded Signup callback (~30s TTL).
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'wabaId must be a numeric id' })
  wabaId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'phoneNumberId must be a numeric id' })
  phoneNumberId!: string;

  // 6-digit two-step-verification PIN used to register the number. Defaults to
  // '000000' when the number has no two-step PIN set.
  @IsString()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'pin must be 6 digits' })
  pin?: string;
}
