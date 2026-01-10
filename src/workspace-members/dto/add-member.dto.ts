// src/workspace-members/dto/add-member.dto.ts
import { IsEnum } from 'class-validator';

export enum MemberRole {
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export class AddMemberDto {
  @IsEnum(MemberRole)
  role: MemberRole;
}