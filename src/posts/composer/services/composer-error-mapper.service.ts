import { Injectable } from '@nestjs/common';
import type { PublishErrorCode } from '../types/draft.types';

export interface ClassifiedError {
  code: PublishErrorCode;
  retryable: boolean;
}

const RETRYABLE: ReadonlySet<PublishErrorCode> = new Set<PublishErrorCode>([
  'rate_limited',
  'transient',
]);

/**
 * A failure whose cause is known where it is thrown (a channel that is not
 * connected, a reminder that could not be sent): it carries its code, so the
 * classifier never has to guess it from the words.
 */
export class ClassifiedPublishError extends Error {
  constructor(
    message: string,
    readonly code: PublishErrorCode,
  ) {
    super(message);
    this.name = 'ClassifiedPublishError';
  }
}

/** An HTTP status as a whole number, never a digit run inside a bigger one. */
const AUTH_STATUS = /(^|[^\d])401([^\d]|$)/;
const RATE_STATUS = /(^|[^\d])429([^\d]|$)/;
const GATEWAY_STATUS = /(^|[^\d])50[234]([^\d]|$)/;

/** What the post carries: the media itself, or a file of it. */
const MEDIA_SUBJECT =
  /\b(media|video|videos|image|images|photo|photos|file|thumbnail|cover|reel|reels|gif)\b/;
/** What a platform says is wrong with a media file. */
const MEDIA_PROBLEM =
  /\b(upload\w*|download\w*|invalid|too large|too big|too long|too short|longer than|shorter than|exceed\w*|duration|aspect ratio|resolution|unsupported|file size|formats?)\b/;

/** Text over a platform's length: the caption, a title, the characters. */
const TEXT_SUBJECT =
  /\b(text|caption|captions|character|characters|title|description|tweet|message)\b/;
const TEXT_PROBLEM = /\b(too long|exceed\w*|over the limit)\b/;

/** A channel whose login ended (stored messages from before the typed error). */
const NOT_CONNECTED = /not connected \(status: (expired|revoked)\)/;

/**
 * Sorts a publish failure into one coarse code by the platform's own words.
 * Shared by Publish now (the composer) and the scheduled job, so the same
 * message always names the same cause. The codes stay coarse on purpose: the
 * platform's message travels next to the code and carries the specifics
 * ("Video is longer than 90 seconds").
 *
 * Order matters: a login problem outranks everything, a rate limit outranks
 * a length check ("Rate limit exceeded" is not text that is too long), a
 * network or gateway failure outranks the media check ("Failed to download
 * media (502)" is the connection, not the file), and a length check on text
 * runs before the media check ("The video title is too long" is about the
 * title).
 */
export function classifyPublishError(err: unknown): ClassifiedError {
  if (err instanceof ClassifiedPublishError) {
    return { code: err.code, retryable: RETRYABLE.has(err.code) };
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (
    AUTH_STATUS.test(msg) ||
    NOT_CONNECTED.test(msg) ||
    msg.includes('invalid_token') ||
    msg.includes('invalid_grant') ||
    msg.includes('unauthorized') ||
    msg.includes('session has expired') ||
    msg.includes('has not authorized application') ||
    msg.includes('error validating access token')
  ) {
    return { code: 'auth_failed', retryable: false };
  }
  if (
    msg.includes('token') &&
    (msg.includes('expired') ||
      msg.includes('revoked') ||
      msg.includes('invalid'))
  ) {
    return { code: 'auth_failed', retryable: false };
  }
  if (
    RATE_STATUS.test(msg) ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('request limit reached') ||
    msg.includes('too_many_posts') ||
    msg.includes('too many posts') ||
    msg.includes('exceeded your quota') ||
    msg.includes('quotaexceeded') ||
    // YouTube's daily upload cap: "exceeded the number of videos they may upload".
    msg.includes('number of videos') ||
    msg.includes('uploadlimitexceeded')
  ) {
    return { code: 'rate_limited', retryable: true };
  }
  if (
    GATEWAY_STATUS.test(msg) ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('eai_again') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('service unavailable') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout')
  ) {
    return { code: 'transient', retryable: true };
  }
  if (TEXT_SUBJECT.test(msg) && TEXT_PROBLEM.test(msg)) {
    return { code: 'content_rejected', retryable: false };
  }
  if (
    (MEDIA_SUBJECT.test(msg) && MEDIA_PROBLEM.test(msg)) ||
    // Only a picture or a video has these, whatever the message calls it.
    msg.includes('aspect ratio') ||
    msg.includes('duration')
  ) {
    return { code: 'media_invalid', retryable: false };
  }
  if (
    msg.includes('duplicate') ||
    msg.includes('rejected') ||
    msg.includes('forbidden content')
  ) {
    return { code: 'content_rejected', retryable: false };
  }
  return { code: 'permanent', retryable: false };
}

@Injectable()
export class ComposerErrorMapperService {
  classify(err: unknown): ClassifiedError {
    return classifyPublishError(err);
  }
}
