import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface SignInMethodChangedProps {
  /** `formatWhen` in the user's time zone: `Oct 26, 2026 at 10:42 AM GMT+5`. */
  when: string;
  /** `deviceLabel`: `Chrome on Windows`, or `Unknown browser`. */
  device: string;
  /** GeoIP country; the row is left out when null (spec §4.4.5). */
  location: string | null;
  /** Which way of signing in changed. Only Google can be unlinked today. */
  method: 'google';
  /** What happened to it. */
  change: 'disconnected';
  /** The "This wasn't me" security link (`not_me`), good for 7 days. */
  resetUrl: string;
}

/** A sign-in method was removed from the account, from Settings. */
export const signInMethodChangedTemplate =
  defineTemplate<SignInMethodChangedProps>({
    id: 'sign-in-method-changed',
    category: 'security',
    event: null,
    footer: 'security',
    subject: () => 'Google sign-in was removed from your Schedura account',
    preheader: () => 'You now sign in with your email and password only.',
    Body: (p) => (
      <>
        <Heading>Google sign-in was removed</Heading>
        <Paragraph>
          Google can no longer be used to sign in to your Schedura account. You
          can still sign in with your email and password.
        </Paragraph>
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
          Wasn’t you? Secure your account now, then check Settings → Security.
        </Callout>
        <EmailButton href={p.resetUrl} variant="secondary">
          This wasn’t me
        </EmailButton>
      </>
    ),
    fixture: {
      when: 'Oct 26, 2026 at 10:42 AM GMT+5',
      device: 'Chrome on Windows',
      location: 'Pakistan',
      method: 'google',
      change: 'disconnected',
      resetUrl: 'https://api.schedura.ai/email/security/EXAMPLE-preview-token',
    },
  });
