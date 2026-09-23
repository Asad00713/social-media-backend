import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Subjects the marketing site's contact form offers.
 *
 * Kept as a closed set rather than free text so the routing and the reply
 * template can both switch on it. A value outside the set is rejected by
 * validation rather than silently treated as "general".
 */
export const CONTACT_TOPICS = [
  'general',
  'support',
  'billing',
  'sales',
  'privacy',
  'legal',
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateContactDto {
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  email: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  company?: string;

  @IsIn(CONTACT_TOPICS)
  topic: ContactTopic;

  @Transform(trim)
  @IsString()
  @Length(10, 5000)
  message: string;

  /**
   * Honeypot.
   *
   * Hidden from real users by CSS, so anything that fills it is automated.
   * Named to look worth filling in — a field called `honeypot` teaches the
   * bot what to skip. The request is accepted and discarded rather than
   * rejected: a 400 tells the sender what tripped it and invites a retry.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
