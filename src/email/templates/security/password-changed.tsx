import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface PasswordChangedProps {
  /** `formatWhen` in the user's time zone: `Oct 26, 2026 at 10:42 AM GMT+5`. */
  when: string;
  /** `deviceLabel`: `Chrome on Windows`, or `Unknown browser`. */
  device: string;
  /** GeoIP country; the row is left out when null (spec §4.4.5). */
  location: string | null;
  /** `settings`: this device stays signed in. `reset`: every session ended. */
  via: 'settings' | 'reset';
  /** The "This wasn't me" security link (`not_me`), good for 7 days. */
  resetUrl: string;
}

const BODY: Record<PasswordChangedProps['via'], string> = {
  settings:
    'You’re still signed in on this device. We signed you out everywhere else.',
  reset: 'We signed you out everywhere. Sign in with your new password.',
};

/** A5: the password was changed, from Settings or by a reset. */
export const passwordChangedTemplate = defineTemplate<PasswordChangedProps>({
  id: 'password-changed',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'Your Schedura password was changed',
  preheader: () => 'We signed you out on other devices.',
  Body: (p) => (
    <>
      <Heading>Your password was changed</Heading>
      <Paragraph>{BODY[p.via]}</Paragraph>
      <DetailRows
        rows={[
          { label: 'When', value: p.when },
          { label: 'Device', value: p.device },
          ...(p.location
            ? [{ label: 'Location', value: `${p.location} (approximate)` }]
            : []),
        ]}
      />
      <Paragraph>If this was you, you don’t need to do anything.</Paragraph>
      <Callout tone="danger">
        Wasn’t you? Reset your password now, then check Settings → Security.
      </Callout>
      <EmailButton href={p.resetUrl} variant="secondary">
        Reset password
      </EmailButton>
    </>
  ),
  fixture: {
    when: 'Oct 26, 2026 at 10:42 AM GMT+5',
    device: 'Chrome on Windows',
    location: 'Pakistan',
    via: 'settings',
    resetUrl: 'https://api.schedura.ai/email/security/EXAMPLE-preview-token',
  },
  variants: {
    reset: {
      when: 'Oct 26, 2026 at 10:42 AM GMT+5',
      device: 'Chrome on Windows',
      location: null,
      via: 'reset',
      resetUrl: 'https://api.schedura.ai/email/security/EXAMPLE-preview-token',
    },
  },
});
