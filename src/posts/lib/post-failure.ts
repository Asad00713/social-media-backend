import {
  PLATFORM_CONFIG,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { classifyPublishError } from '../composer/services/composer-error-mapper.service';
import type { PublishErrorCode } from '../composer/types/draft.types';

export interface PostFailure {
  message: string;
  needsReconnect: boolean;
}

export function describeFailure(input: {
  platform: SupportedPlatform;
  errorCode?: PublishErrorCode;
  errorMessage?: string | null;
}): PostFailure {
  const name = PLATFORM_CONFIG[input.platform].name;
  const text = input.errorMessage?.trim() ?? '';
  const code =
    input.errorCode ?? (text ? classifyPublishError(text).code : undefined);

  switch (code) {
    case 'auth_failed':
      return {
        message: `${name} logged you out. Reconnect, then retry. Nothing was posted.`,
        needsReconnect: true,
      };
    case 'rate_limited':
      return {
        message: `${name} is limiting how often you can post. Wait a little, then retry.`,
        needsReconnect: false,
      };
    case 'media_invalid':
      return {
        message: `${name} rejected the media. Check the file type and size, then edit the post.`,
        needsReconnect: false,
      };
    case 'content_rejected':
      return {
        message: `${name} rejected this post. Edit it and try again.`,
        needsReconnect: false,
      };
    case 'transient':
      return {
        message: `We couldn't reach ${name}. Try again in a moment.`,
        needsReconnect: false,
      };
    default:
      return {
        message: text || `${name} could not publish this post.`,
        needsReconnect: false,
      };
  }
}
