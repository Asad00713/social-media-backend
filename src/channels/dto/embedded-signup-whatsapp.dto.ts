import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class EmbeddedSignupWhatsAppDto {
  // Short-lived exchangeable code from the Embedded Signup callback (~30s TTL).
  @IsString()
  @IsNotEmpty()
  code!: string;

  // Both ids are OPTIONAL. They only reach us when Meta's `WA_EMBEDDED_SIGNUP`
  // postMessage actually lands in the browser, which is not guaranteed. When
  // either is absent the onboarding service derives it from the business token,
  // which is authoritative about what the customer granted.
  @IsString()
  @IsOptional()
  @Matches(/^\d+$/, { message: 'wabaId must be a numeric id' })
  wabaId?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\d+$/, { message: 'phoneNumberId must be a numeric id' })
  phoneNumberId?: string;

  // 6-digit two-step-verification PIN used to register the number. Defaults to
  // '000000' when the number has no two-step PIN set.
  @IsString()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'pin must be 6 digits' })
  pin?: string;
}
