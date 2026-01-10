// src/workspace-members/dto/accept-invitation.dto.ts
import { IsString } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  token: string;
}