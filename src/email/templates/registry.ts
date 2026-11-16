import { BILLING_TEMPLATES } from './billing';
import { INBOX_TEMPLATES } from './inbox';
import { LIFECYCLE_TEMPLATES } from './lifecycle';
import { PUBLISHING_TEMPLATES } from './publishing';
import { REPORTS_TEMPLATES } from './reports';
import { SECURITY_TEMPLATES } from './security';
import { SUPPORT_TEMPLATES } from './support';
import { TEAM_TEMPLATES } from './team';
import type { AnyTemplateDef } from './types';

/** Every registered template, across the 8 groups. */
export const ALL_TEMPLATES: AnyTemplateDef[] = [
  ...SECURITY_TEMPLATES,
  ...TEAM_TEMPLATES,
  ...PUBLISHING_TEMPLATES,
  ...BILLING_TEMPLATES,
  ...SUPPORT_TEMPLATES,
  ...LIFECYCLE_TEMPLATES,
  ...INBOX_TEMPLATES,
  ...REPORTS_TEMPLATES,
];

const BY_ID = new Map<string, AnyTemplateDef>(
  ALL_TEMPLATES.map((def) => [def.id, def]),
);

export function getTemplate(id: string): AnyTemplateDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown email template "${id}"`);
  return def;
}
