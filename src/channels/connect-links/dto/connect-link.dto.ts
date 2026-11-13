import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** `POST /channels/workspaces/:workspaceId/connect-links` */
export class CreateConnectLinkDto {
  /** Optional: a link that is only copied has no email. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  /** Platform ids the link offers; each must be one of CONNECT_LINK_NETWORKS. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  networks!: string[];

  /** Email the link now. Needs `email`. */
  @IsBoolean()
  send!: boolean;
}

export interface ConnectLinkConnectedDto {
  platform: string;
  channelId: number;
  accountName: string;
  avatarUrl: string | null;
  /** ISO time the account was connected through the link. */
  connectedAt: string | null;
}

export interface ConnectLinkDto {
  id: string;
  email: string | null;
  networks: string[];
  status: 'open' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
  lastSentAt: string | null;
  createdBy: { id: string; name: string; avatarUrl: string | null };
  /** Workspace channels added through this link. */
  connected: ConnectLinkConnectedDto[];
}

/** `POST …/connect-links` and `GET …/connect-links/:linkId`. */
export interface ConnectLinkWithUrlResponse {
  link: ConnectLinkDto;
  /** The full public URL, ending in the raw token. */
  url: string;
}

/** `POST …/:linkId/resend` and `POST …/:linkId/revoke`. */
export interface ConnectLinkResponse {
  link: ConnectLinkDto;
}
