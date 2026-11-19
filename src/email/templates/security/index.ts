import type { AnyTemplateDef } from '../types';
import { adminLoginCodeTemplate } from './admin-login-code';
import { NEW_SIGN_IN } from './new-sign-in';
import { changeEmailCodeTemplate } from './change-email-code';
import { emailChangedTemplate } from './email-changed';
import { passwordChangedTemplate } from './password-changed';
import { resetPasswordTemplate } from './reset-password';
import { signInMethodChangedTemplate } from './sign-in-method-changed';
import { verifyEmailTemplate } from './verify-email';

/** The security templates. Each template task appends its def here. */
export const SECURITY_TEMPLATES: AnyTemplateDef[] = [
  verifyEmailTemplate,
  resetPasswordTemplate,
  passwordChangedTemplate,
  NEW_SIGN_IN,
  signInMethodChangedTemplate,
  changeEmailCodeTemplate,
  emailChangedTemplate,
  adminLoginCodeTemplate,
];
