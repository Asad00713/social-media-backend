import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsBoolean,
  IsInt,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MAESTRO_TONES,
  type MaestroTone,
} from '../../drizzle/schema/users.schema';
import {
  AGENT_RUNTIMES,
  type AgentRuntimeKind,
} from '../runtime/runtime-selector';

/** Models the UI may request. Kept in sync with the frontend model switcher. */
export const MAESTRO_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
] as const;
export type MaestroModel = (typeof MAESTRO_MODELS)[number];

/** Attachment policy — shared by the presign endpoint and the send DTO. Limits
 *  are intentionally well under Claude's hard caps (5 MB image / 32 MB PDF) to
 *  leave buffer. */
export const MAESTRO_ATTACHMENT_KINDS = ['image', 'pdf'] as const;
export type MaestroAttachmentKind = (typeof MAESTRO_ATTACHMENT_KINDS)[number];
export const MAESTRO_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export const MAESTRO_PDF_MIME = 'application/pdf';
export const MAESTRO_ATTACHMENT_MIME = [
  ...MAESTRO_IMAGE_MIME,
  MAESTRO_PDF_MIME,
] as const;
export const MAESTRO_IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAESTRO_PDF_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAESTRO_MAX_ATTACHMENTS = 5;

export class CreateMaestroConversationDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  title?: string;
}

export class SetFeedbackDto {
  @IsOptional()
  @IsIn(['good', 'bad'])
  feedback?: 'good' | 'bad' | null;
}

/** Request a presigned R2 upload URL for a Maestro chat attachment. */
export class PresignMaestroAttachmentDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsIn(MAESTRO_ATTACHMENT_KINDS)
  kind!: MaestroAttachmentKind;

  @IsIn(MAESTRO_ATTACHMENT_MIME)
  contentType!: (typeof MAESTRO_ATTACHMENT_MIME)[number];

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

/** One uploaded attachment submitted alongside a message. */
export class MaestroAttachmentDto {
  @IsString()
  @IsNotEmpty()
  url!: string;

  @IsIn(MAESTRO_ATTACHMENT_MIME)
  mediaType!: (typeof MAESTRO_ATTACHMENT_MIME)[number];

  @IsIn(MAESTRO_ATTACHMENT_KINDS)
  kind!: MaestroAttachmentKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsInt()
  @Min(1)
  size!: number;
}

/** The user's answer to a confirm card, carried as data rather than prose. */
export class MaestroApprovalDto {
  /** The assistant message whose card is being answered. */
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  /** The option the user picked, verbatim. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  option!: string;
}

/**
 * The entity a route names, when it names one — the campaign on a campaign
 * page, the post being edited. Lets the agent act on "this one" without
 * asking which.
 */
export class MaestroPageEntityDto {
  @IsString()
  @MaxLength(40)
  kind!: string;

  @IsString()
  @MaxLength(200)
  id!: string;
}

/**
 * Where the user is in the app when they send this turn.
 *
 * Deliberately a DESCRIPTION, not the page's data: a screen's contents would
 * be a large payload on every message, and the tools the agent already has
 * return fresher data than a snapshot taken when the message was typed.
 *
 * The client builds this from its own route table, so the names here are the
 * frontend's vocabulary; the backend only passes them through to the prompt.
 */
export class MaestroPageContextDto {
  /** Stable key for the screen, e.g. 'planner', 'settings-profile'. */
  @IsString()
  @MaxLength(60)
  page!: string;

  /** How to say it in prose, e.g. "the Planner". */
  @IsString()
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MaestroPageEntityDto)
  entity?: MaestroPageEntityDto;
}

export class SendMaestroMessageDto {
  @IsString()
  @MaxLength(8000)
  message!: string;

  /** Optional model override; falls back to the service default when omitted. */
  @IsOptional()
  @IsString()
  @IsIn(MAESTRO_MODELS)
  model?: MaestroModel;

  /** User setting: confirm before any outward send/publish (default true). */
  @IsOptional()
  @IsBoolean()
  confirmBeforeSend?: boolean;

  /** User setting: allow the web_search tool this turn (default true). */
  @IsOptional()
  @IsBoolean()
  webSearch?: boolean;

  /**
   * Which runtime answers this turn: the Claude Agent SDK, or the Messages
   * API. Omitted means `sdk` — the bridges and any older client keep the
   * behaviour they have today.
   */
  @IsOptional()
  @IsIn(AGENT_RUNTIMES)
  runtime?: AgentRuntimeKind;

  /** Files (images/PDF) attached to this turn, already uploaded to R2. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAESTRO_MAX_ATTACHMENTS)
  @ValidateNested({ each: true })
  @Type(() => MaestroAttachmentDto)
  attachments?: MaestroAttachmentDto[];

  /**
   * Set when this turn answers a confirm card, instead of being free-typed.
   *
   * Without it the choice arrives as ordinary chat text and the model has to
   * work out which card it answered and which tool to re-run — which is
   * exactly what produced duplicate confirmation prompts.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => MaestroApprovalDto)
  approval?: MaestroApprovalDto;

  /**
   * The screen the user is looking at. Absent for the bridges (Telegram,
   * WhatsApp) and any older client — there is no page there, and the prompt
   * simply says nothing about location.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => MaestroPageContextDto)
  pageContext?: MaestroPageContextDto;
}

/** Save a workspace's own Anthropic API key (BYOK). */
export class SetMaestroKeyDto {
  @IsString()
  @IsNotEmpty()
  workspaceId: string;

  @IsString()
  @IsNotEmpty()
  apiKey: string;
}

/** Target a workspace for key removal / wizard completion. */
export class MaestroWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}

/** Body for PATCH /maestro/tone -- the caller's own Maestro reply style. */
export class SetMaestroToneDto {
  @IsIn(MAESTRO_TONES)
  tone!: MaestroTone;
}
