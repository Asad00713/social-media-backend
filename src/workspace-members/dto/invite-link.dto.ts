// src/workspace-members/dto/invite-link.dto.ts
import { IsBoolean } from 'class-validator';

export class SetInviteLinkDto {
  @IsBoolean()
  enabled: boolean;
}
