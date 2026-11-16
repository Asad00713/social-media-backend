import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface PaymentFailedProps {
  planName: string;
  /** Already formatted, e.g. `$29.00`. */
  amount: string;
  /** `Visa •• 4242`; null when the provider did not say. */
  card: string | null;
  /** The bank's reason as a sentence; null when the provider gave none. */
  reason: string | null;
  /** A formatted day; null when no retry is scheduled or known. */
  nextTry: string | null;
  /** What the FREE plan allows; null when it could not be read. */
  freeChannels: number | null;
  billingUrl: string;
}

const BILLING_URL = 'https://app.schedura.test/w/ws_1/settings/billing';

function restriction(freeChannels: number | null): string {
  const lead =
    'If payments keep failing, your workspaces move to Free. Nothing is deleted';
  if (freeChannels === null) return `${lead}.`;
  const channels = freeChannels === 1 ? 'channel keeps' : 'channels keep';
  return `${lead}, but only ${freeChannels} ${channels} publishing.`;
}

/** D1. Figma's date is the 3-failure rule here (spec §4.4 item 3). */
export const PAYMENT_FAILED = defineTemplate<PaymentFailedProps>({
  id: 'payment-failed',
  category: 'billing',
  event: null,
  footer: 'billing',
  subject: (p) => `Your payment for Schedura ${p.planName} didn’t go through`,
  preheader: (p) =>
    p.nextTry
      ? `We’ll try again on ${p.nextTry}. Update your card to keep ${p.planName}.`
      : `Update your card to keep ${p.planName}.`,
  Body: (p) => (
    <>
      <Heading>Your payment didn’t go through</Heading>
      <Paragraph>
        {`We couldn’t charge your card for Schedura ${p.planName}.${
          p.reason ? ` Your bank said: ${p.reason}` : ''
        }`}
      </Paragraph>
      <DetailRows
        rows={[
          { label: 'Plan', value: `${p.planName} · monthly` },
          { label: 'Amount', value: p.amount },
          ...(p.card ? [{ label: 'Card', value: p.card }] : []),
          ...(p.nextTry ? [{ label: 'Next try', value: p.nextTry }] : []),
        ]}
      />
      <Callout tone="warning">{restriction(p.freeChannels)}</Callout>
      <EmailButton href={p.billingUrl} variant="primary">
        Update card
      </EmailButton>
    </>
  ),
  fixture: {
    planName: 'Pro',
    amount: '$29.00',
    card: 'Visa •• 4242',
    reason: 'insufficient funds.',
    nextTry: 'Oct 29, 2026',
    freeChannels: 3,
    billingUrl: BILLING_URL,
  },
  variants: {
    'no-card-no-next-try': {
      planName: 'Pro',
      amount: '$29.00',
      card: null,
      reason: null,
      nextTry: null,
      freeChannels: 3,
      billingUrl: BILLING_URL,
    },
  },
});
