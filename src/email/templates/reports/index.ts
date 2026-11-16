import type { AnyTemplateDef } from '../types';
import { insightReport } from './insight-report';
import { leadDelivered } from './lead-delivered';

/** The reports templates. Each template task appends its def here. */
export const REPORTS_TEMPLATES: AnyTemplateDef[] = [
  insightReport,
  leadDelivered,
];
