import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface TrialEndingProps {
  planName: string;
  /** A formatted day, e.g. `Nov 2, 2026`. */
  trialEnd: string;
  daysLeft: number;
  workspaceName: string;
  /** false = the provider says no card is on file; null = unknown. */
  hasCard: boolean | null;
  /** The plan's channel limit; null = unlimited. */
  channels: number | null;
  /** The "What changes on Free" rows, already worded. */
  changes: Array<{ label: string; value: string }>;
  billingUrl: string;
}

const BILLING_URL = 'https://app.schedura.test/w/ws_1/settings/billing';

function intro(p: TrialEndingProps): string {
  if (p.hasCard === false) {
    return `On ${p.trialEnd}, ${p.workspaceName} moves to Free unless you choose a plan. No card is on file, so nothing is charged automatically.`;
  }
  return `On ${p.trialEnd}, your ${p.planName} trial ends. If you do nothing, ${p.planName} renews on ${p.trialEnd}.`;
}

/** D2. Shows what changes on Free instead of selling (spec §4.4 item 4). */
export const TRIAL_ENDING = defineTemplate<TrialEndingProps>({
  id: 'trial-ending',
  category: 'billing',
  event: null,
  footer: 'billing',
  subject: (p) => `Your ${p.planName} trial ends on ${p.trialEnd}`,
  preheader: (p) =>
    `Choose a plan to keep publishing to ${
      p.channels === null ? 'all your channels' : `all ${p.channels} channels`
    }.`,
  Body: (p) => (
    <>
      <Heading>
        {`Your ${p.planName} trial ends in ${p.daysLeft} ${
          p.daysLeft === 1 ? 'day' : 'days'
        }`}
      </Heading>
      <Paragraph>{intro(p)}</Paragraph>
      <DetailRows title="What changes on Free" rows={p.changes} />
      <EmailButton href={p.billingUrl} variant="primary">
        Choose a plan
      </EmailButton>
    </>
  ),
  fixture: {
    planName: 'Pro',
    trialEnd: 'Nov 2, 2026',
    daysLeft: 3,
    workspaceName: 'Rehman Workspace',
    hasCard: false,
    channels: 8,
    changes: [
      { label: 'Channels', value: '8 → 3 publishing' },
      { label: 'Members', value: '4 → 1' },
      { label: 'AI credits', value: '2,000 → 0 a month' },
      { label: 'Your posts', value: 'All kept' },
    ],
    billingUrl: BILLING_URL,
  },
  variants: {
    'card-on-file': {
      planName: 'Pro',
      trialEnd: 'Nov 2, 2026',
      daysLeft: 3,
      workspaceName: 'Rehman Workspace',
      hasCard: true,
      channels: null,
      changes: [
        { label: 'Channels', value: 'Unlimited → 3 publishing' },
        { label: 'Members', value: '4 → 1' },
        { label: 'AI credits', value: 'Unlimited → 0 a month' },
        { label: 'Your posts', value: 'All kept' },
      ],
      billingUrl: BILLING_URL,
    },
  },
});
