import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ConnectWhatsAppDto {
  @IsString()
  @IsNotEmpty()
  phoneNumberId!: string;

  @IsString()
  @IsNotEmpty()
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
