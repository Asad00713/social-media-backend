import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { MemberRole } from './add-member.dto';

export const INVITATION_MESSAGE_MAX = 500;

/** Trimmed; a blank note is no note, so it reaches the service as undefined. */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

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

  /** The inviter's personal note, shown in every invitation email of this batch. */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(INVITATION_MESSAGE_MAX)
  message?: string;
}
