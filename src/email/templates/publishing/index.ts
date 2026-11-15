import type { AnyTemplateDef } from '../types';
import { POST_FAILED } from './post-failed';
import { POSTS_FAILED } from './posts-failed';

/** The publishing templates. Each template task appends its def here. */
export const PUBLISHING_TEMPLATES: AnyTemplateDef[] = [
  POST_FAILED,
  POSTS_FAILED,
];
