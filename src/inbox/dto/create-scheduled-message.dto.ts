import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  isISO8601,
  isUUID,
} from 'class-validator';
import { SCHEDULED_INBOX_TYPES } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import type { ScheduledInboxType } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import { DmAttachmentDto } from './send-dm.dto';

/**
 * The target is EITHER the new `inboxConversationId` OR the legacy
 * `type` + `threadKey` pair, never both and never neither.
 */
@ValidatorConstraint({ name: 'scheduledTargetShape', async: false })
export class ScheduledTargetShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const o = args.object as CreateScheduledMessageDto;
    const hasNew = value !== undefined;
    const hasLegacy = o.type !== undefined || o.threadKey !== undefined;
    if (hasNew === hasLegacy) return false;
    if (hasNew) return typeof value === 'string' && isUUID(value);
    return o.type !== undefined && o.threadKey !== undefined;
  }
  defaultMessage(): string {
    return 'Send either inboxConversationId, or type together with threadKey, but not both';
  }
}

/** Exactly one of `sendAt` / legacy `scheduledAt`, in ISO form. */
@ValidatorConstraint({ name: 'scheduledTimeShape', async: false })
export class ScheduledTimeShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const o = args.object as CreateScheduledMessageDto;
    const hasNew = value !== undefined;
    if (hasNew === (o.scheduledAt !== undefined)) return false;
    return !hasNew || (typeof value === 'string' && isISO8601(value));
  }
  defaultMessage(): string {
    return 'Send exactly one of sendAt or scheduledAt, as an ISO 8601 date';
  }
}

export class CreateScheduledMessageDto {
  /** New shape: the inbox conversation this reply belongs to. */
  @Validate(ScheduledTargetShapeConstraint)
  inboxConversationId?: string;

  /** Legacy shape. */
  @IsOptional()
  @IsEnum(SCHEDULED_INBOX_TYPES)
  type?: ScheduledInboxType;

  /**
   * Legacy shape.
   * For dm:            `<channelId>:<conversationId>`
   * For comment (top): `<channelId>:<platformPostId>`
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  threadKey?: string;

  /** Required when scheduling a nested reply (must match a real inbox_items row). */
  @IsOptional()
  @IsUUID()
  parentItemId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DmAttachmentDto)
  attachments?: DmAttachmentDto[];

  @Validate(ScheduledTimeShapeConstraint)
  sendAt?: string;

  /** Legacy name of `sendAt`. */
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetLabel?: string;
}
