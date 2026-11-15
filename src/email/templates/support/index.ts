import type { AnyTemplateDef } from '../types';
import { contactEnquiryTemplate } from './contact-enquiry';
import { contactReceivedTemplate } from './contact-received';

/** The support templates. Each template task appends its def here. */
export const SUPPORT_TEMPLATES: AnyTemplateDef[] = [
  contactReceivedTemplate,
  contactEnquiryTemplate,
];
