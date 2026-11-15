import type { AnyTemplateDef } from '../types';
import { inboxActivity } from './inbox-activity';

/** The inbox templates. Each template task appends its def here. */
export const INBOX_TEMPLATES: AnyTemplateDef[] = [inboxActivity];
