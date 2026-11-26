import { BadRequestException } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  validate,
  ValidateNested,
  type ValidationError,
} from 'class-validator';

export const LEAD_ROUTE_TYPES = ['inbox', 'email', 'webhook'] as const;
export type LeadRouteType = (typeof LEAD_ROUTE_TYPES)[number];

/**
 * `require_tld: false` lets `localhost` and IP literals through to the
 * save-time public-host check (assertWebhookUrl), whose copy says why.
 */
const WEBHOOK_URL_OPTIONS = {
  protocols: ['http', 'https'],
  require_protocol: true,
  require_valid_protocol: true,
  require_tld: false,
};

/** An inbox route takes no settings. */
export class InboxRouteConfigDto {}

/** The key the lead wizard sends (use-create-lead-campaign.ts). */
export class EmailRouteConfigDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class WebhookRouteConfigDto {
  @IsString()
  @MaxLength(2048)
  @IsUrl(WEBHOOK_URL_OPTIONS)
  url!: string;

  /** The wizard sends `''` when no secret was typed. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  secret?: string;
}

const CONFIG_CLASSES: Record<LeadRouteType, new () => object> = {
  inbox: InboxRouteConfigDto,
  email: EmailRouteConfigDto,
  webhook: WebhookRouteConfigDto,
};

/** The config class for a route type; an unknown type gets the empty one. */
function configClassFor(type: unknown): new () => object {
  return (LEAD_ROUTE_TYPES as readonly unknown[]).includes(type)
    ? CONFIG_CLASSES[type as LeadRouteType]
    : InboxRouteConfigDto;
}

export class CreateLeadRouteDto {
  @IsIn(LEAD_ROUTE_TYPES)
  type!: LeadRouteType;

  /** Validated as the class its sibling `type` names. */
  @IsObject()
  @ValidateNested()
  @Type((opts) => configClassFor((opts?.object as { type?: unknown })?.type))
  config!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * A PATCH carries no type: its `config` is checked against the stored
 * route's type with `assertRouteConfig`.
 */
export class UpdateLeadRouteDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

/** The test button sends the webhook route's own config shape. */
export class TestWebhookDto extends WebhookRouteConfigDto {}

function messagesOf(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) => `${prefix}${m}`),
    ...messagesOf(e.children ?? [], `${prefix}${e.property}.`),
  ]);
}

/**
 * Checks a route config against `type` with the global ValidationPipe's own
 * options (main.ts: `whitelist` + `forbidNonWhitelisted`), so an unknown key
 * is refused exactly as it would be at the top level of a body. The 400
 * lists every message, as the pipe's does.
 */
export async function assertRouteConfig(
  type: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (!(LEAD_ROUTE_TYPES as readonly string[]).includes(type)) {
    throw new BadRequestException([`config: unknown route type "${type}"`]);
  }
  // forbidUnknownValues is off as in Nest's pipe: the inbox class has no
  // rules, and `whitelist` still refuses any key it is given.
  const errors = await validate(plainToInstance(configClassFor(type), config), {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  if (errors.length) {
    throw new BadRequestException(messagesOf(errors, 'config.'));
  }
}
