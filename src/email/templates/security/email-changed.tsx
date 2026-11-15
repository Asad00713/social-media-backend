import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface EmailChangedProps {
  /** The old address; it is also the recipient. */
  from: string;
  /** The new sign-in address. */
  to: string;
  /** `formatWhen` in the user's time zone: `Oct 26, 2026 at 10:42 AM GMT+5`. */
  when: string;
  /** `Chrome on Windows · Pakistan`; just the browser when the country is unknown. */
  device: string;
  /** The "Secure my account" security link (`revert_email`), good for 7 days. */
  secureUrl: string;
}

/** A4: the sign-in email was changed. Sent to the OLD address, with a way back. */
export const emailChangedTemplate = defineTemplate<EmailChangedProps>({
  id: 'email-changed',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'Your Schedura email was changed',
  preheader: (p) =>
    `New sign-in email: ${p.to}. Wasn't you? Secure your account.`,
  Body: (p) => (
    <>
      <Heading>Your sign-in email was changed</Heading>
      <DetailRows
        rows={[
          { label: 'From', value: p.from },
          { label: 'To', value: p.to },
          { label: 'When', value: p.when },
          { label: 'Device', value: p.device },
        ]}
      />
      <Callout tone="warning">
        Wasn't you? Secure your account now. This link works for 7 days and
        switches your email back.
      </Callout>
      <EmailButton href={p.secureUrl} variant="secondary">
        Secure my account
      </EmailButton>
    </>
  ),
  fixture: {
    from: 'rehman@lumierecafe.pk',
    to: 'rehman@lumiere.cafe',
    when: 'Oct 26, 2026 at 10:42 AM GMT+5',
    device: 'Chrome on Windows · Pakistan',
    secureUrl: 'https://api.schedura.ai/email/security/EXAMPLE-preview-token',
  },
});
