// src/workspace-members/dto/invite-member.dto.ts
import { IsEmail, IsEnum, IsOptional } from 'class-validator';
import { MemberRole } from './add-member.dto';

export class InviteMemberDto {
    @IsEmail()
    email: string;

    @IsEnum(MemberRole)
    @IsOptional()
    role?: MemberRole = MemberRole.MEMBER;
}