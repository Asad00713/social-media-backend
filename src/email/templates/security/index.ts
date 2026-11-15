import type { AnyTemplateDef } from '../types';
import { passwordChangedTemplate } from './password-changed';
import { resetPasswordTemplate } from './reset-password';
import { verifyEmailTemplate } from './verify-email';

/** The security templates. Each template task appends its def here. */
export const SECURITY_TEMPLATES: AnyTemplateDef[] = [
  verifyEmailTemplate,
  resetPasswordTemplate,
  passwordChangedTemplate,
];
