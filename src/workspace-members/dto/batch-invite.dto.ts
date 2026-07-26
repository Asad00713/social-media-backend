import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { MemberRole } from './add-member.dto';

export class BatchInviteItemDto {
  @IsEmail()
  email: string;

  @IsEnum(MemberRole)
  @IsOptional()
  role?: MemberRole = MemberRole.MEMBER;
}

export class BatchInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchInviteItemDto)
  invites: BatchInviteItemDto[];
}
