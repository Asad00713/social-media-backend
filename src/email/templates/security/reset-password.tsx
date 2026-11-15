import { EmailButton } from '../../render/components/button';
import { FallbackLink } from '../../render/components/fallback-link';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface ResetPasswordProps {
  /** The account's address, shown in bold; it is also the recipient. */
  email: string;
  /** `FRONTEND_URL/reset-password?token=…`, good once for one hour. */
  resetUrl: string;
}

/** A2: the password reset link. Carries a reset token, so it is sent inline (sendNow). */
export const resetPasswordTemplate = defineTemplate<ResetPasswordProps>({
  id: 'reset-password',
  category: 'security',
  event: null,
  footer: 'plain',
  subject: () => 'Reset your Schedura password',
  preheader: () => 'This link works once, for the next hour.',
  footerReason: () =>
    'You get this because a password reset was requested for your account.',
  Body: (p) => (
    <>
      <Heading>Reset your password</Heading>
      <Paragraph>
        We got a request to reset the password for <Strong>{p.email}</Strong>.
      </Paragraph>
      <EmailButton href={p.resetUrl} variant="primary">
        Choose a new password
      </EmailButton>
      <FallbackLink href={p.resetUrl} />
      <Paragraph tone="muted">
        The link works once, for 1 hour. Didn't ask for this? Ignore this email
        and your password stays the same.
      </Paragraph>
    </>
  ),
  fixture: {
    email: 'rehman@lumierecafe.pk',
    resetUrl:
      'https://app.schedura.ai/reset-password?token=3q2-7wEXAMPLEtokenONLYforPREVIEWS',
  },
});
