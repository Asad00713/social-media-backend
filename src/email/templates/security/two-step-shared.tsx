import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { DetailRows } from '../../render/components/detail-rows';

/** What every two-step sign-in security email shows (R16). */
export interface TwoStepNoticeProps {
  /** `formatWhen` in the user's time zone: `Oct 26, 2026 at 10:42 AM GMT+5`. */
  when: string;
  /** `deviceLabel`: `Chrome on Windows`, or `Unknown browser`. */
  device: string;
  /** GeoIP country; the row is left out when null. */
  location: string | null;
  /** The "This wasn't me" security link (`not_me`). */
  notMeUrl: string;
}

export const TWO_STEP_FIXTURE: TwoStepNoticeProps = {
  when: 'Oct 26, 2026 at 10:42 AM GMT+5',
  device: 'Chrome on Windows',
  location: 'Pakistan',
  notMeUrl: 'https://api.schedura.ai/email/security/EXAMPLE-preview-token',
};

/** When / Device / Location rows. */
export function TwoStepDetails({ p }: { p: TwoStepNoticeProps }) {
  return (
    <DetailRows
      rows={[
        { label: 'When', value: p.when },
        { label: 'Device', value: p.device },
        ...(p.location
          ? [{ label: 'Location', value: `${p.location} (approximate)` }]
          : []),
      ]}
    />
  );
}

/** "If this wasn't you, secure your account" and the not-me button. */
export function NotMe({ p }: { p: TwoStepNoticeProps }) {
  return (
    <>
      <Callout tone="danger">
        If this wasn’t you, secure your account now.
      </Callout>
      <EmailButton href={p.notMeUrl} variant="secondary">
        This wasn’t me
      </EmailButton>
    </>
  );
}
