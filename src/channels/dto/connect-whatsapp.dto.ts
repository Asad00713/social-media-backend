import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class ConnectWhatsAppDto {
  // WhatsApp phone_number_id is always a numeric string. Constrain it: this value
  // is interpolated into the Meta Graph URL, so digits-only prevents URL/path
  // injection (and rejects obvious typos early).
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'phoneNumberId must be a numeric id' })
  phoneNumberId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'wabaId must be a numeric id' })
  wabaId!: string;

  @IsString()
  @IsNotEmpty()
  accessToken!: string;

  @IsString()
  @IsOptional()
  displayPhoneNumber?: string;

  @IsString()
  @IsOptional()
  accountName?: string;
}
