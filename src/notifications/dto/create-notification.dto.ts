import { IsEnum, IsOptional, IsString, IsObject } from 'class-validator';
import { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } from 'src/drizzle/schema';

export class CreateNotificationDto {
  @IsString()
  userId: string;

  @IsEnum(NOTIFICATION_TYPES)
  type: (typeof NOTIFICATION_TYPES)[number];

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsEnum(NOTIFICATION_PRIORITIES)
  priority?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  actionUrl?: string;
}
