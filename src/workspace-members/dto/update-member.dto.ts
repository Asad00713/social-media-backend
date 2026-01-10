// src/workspace-members/dto/update-member.dto.ts
import { IsEnum } from 'class-validator';
import { MemberRole } from './add-member.dto';

export class UpdateMemberDto {
    @IsEnum(MemberRole)
    role: MemberRole;
}