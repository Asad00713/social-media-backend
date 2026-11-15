import type { AnyTemplateDef } from '../types';
import { APPROVAL_NEEDED } from './approval-needed';
import { channelReconnect } from './channel-reconnect';
import { POST_APPROVED } from './post-approved';
import { POST_FAILED } from './post-failed';
import { POSTS_FAILED } from './posts-failed';

/** The publishing templates. Each template task appends its def here. */
export const PUBLISHING_TEMPLATES: AnyTemplateDef[] = [
  POST_FAILED,
  POSTS_FAILED,
  channelReconnect,
  APPROVAL_NEEDED,
  POST_APPROVED,
];
