import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface NewSignInProps {
  /** `formatWhen` output: 'Oct 26, 2026 at 9:58 PM GMT+5'. */
  when: string;
  /** The parsed browser: 'Chrome on Windows'. */
  device: string;
  /** GeoIP country, or null when unknown (the row is then omitted). */
  location: string | null;
  ip: string | null;
  /** The "not me" security link (spec §7.3). */
  notMeUrl: string;
}

/** 'Oct 26, 2026 at 9:58 PM GMT+5' -> 'Oct 26 at 9:58 PM' for the preheader. */
function shortWhen(when: string): string {
  const m = /^([A-Z][a-z]{2} \d{1,2}), \d{4} at (\d{1,2}:\d{2} [AP]M)/.exec(
    when,
  );
  return m ? `${m[1]} at ${m[2]}` : when;
}

/** A6: a sign-in from a device we have not seen before (spec §7.4). */
export const NEW_SIGN_IN = defineTemplate<NewSignInProps>({
  id: 'new-sign-in',
  category: 'security',
  event: null,
  footer: 'security',
  subject: (p) => `New sign-in to Schedura from ${p.device}`,
  preheader: (p) =>
    `${p.location ?? 'Unknown location'} · ${shortWhen(p.when)}`,
  Body: (p) => (
    <>
      <Heading>New sign-in to your account</Heading>
      <Paragraph>
        Someone signed in from a device we haven&apos;t seen before.
      </Paragraph>
      <DetailRows
        rows={[
          { label: 'Time', value: p.when },
          { label: 'Device', value: p.device },
          ...(p.location
            ? [{ label: 'Location', value: `${p.location} (approximate)` }]
            : []),
          ...(p.ip ? [{ label: 'IP address', value: p.ip }] : []),
        ]}
      />
      <Paragraph tone="muted">
        If this was you, there&apos;s nothing else to do.
      </Paragraph>
      <EmailButton href={p.notMeUrl} variant="secondary">
        This wasn&apos;t me
      </EmailButton>
    </>
  ),
  fixture: {
    when: 'Oct 26, 2026 at 9:58 PM GMT+5',
    device: 'Chrome on Windows',
    location: 'Pakistan',
    ip: '39.48.12.201',
    notMeUrl: 'https://api.schedura.ai/email/security/preview-token',
  },
  variants: {
    'no-location': {
      when: 'Oct 26, 2026 at 9:58 PM GMT+5',
      device: 'Unknown browser',
      location: null,
      ip: null,
      notMeUrl: 'https://api.schedura.ai/email/security/preview-token',
    },
  },
});
