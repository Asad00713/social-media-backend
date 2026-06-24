import { Injectable } from '@nestjs/common';
import type { PublishErrorCode } from '../types/draft.types';

export interface ClassifiedError {
  code: PublishErrorCode;
  retryable: boolean;
}

@Injectable()
export class ComposerErrorMapperService {
  classify(err: unknown): ClassifiedError {
    const msg = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();

    if (
      msg.includes('401') ||
      msg.includes('invalid_token') ||
      msg.includes('unauthorized')
    ) {
      return { code: 'auth_failed', retryable: false };
    }
    if (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests')
    ) {
      return { code: 'rate_limited', retryable: true };
    }
    if (
      msg.includes('media') &&
      (msg.includes('upload') ||
        msg.includes('invalid') ||
        msg.includes('too large') ||
        msg.includes('exceeds'))
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
    if (
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('network') ||
      msg.includes('socket hang up')
    ) {
      return { code: 'transient', retryable: true };
    }
    return { code: 'permanent', retryable: false };
  }
}
