import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export type PlanChangeKind =
  | 'upgraded'
  | 'downgraded'
  | 'downgrade_scheduled'
  | 'cancel_scheduled'
  | 'ended'
  | 'payment_restricted';

export interface PlanChangedProps {
  kind: PlanChangeKind;
  fromPlan: string;
  toPlan: string;
  /** `$29 monthly`; null when not known. */
  billed: string | null;
  /** A formatted day; null when not known. */
  nextCharge: string | null;
  /** A formatted day; null when not known. */
  endsOn: string | null;
  /** The new plan's per-workspace limits; null = unlimited or unknown. */
  channels: number | null;
  members: number | null;
  /** Only a Stripe upgrade has a Stripe receipt coming. */
  showStripeReceipt: boolean;
  billingUrl: string;
}

const BILLING_URL = 'https://app.schedura.test/w/ws_1/settings/billing';
const STRIPE_RECEIPT = 'Stripe sends the receipt in a separate email.';

function heading(p: PlanChangedProps): string {
  switch (p.kind) {
    case 'upgraded':
    case 'downgraded':
      return `You're on Schedura ${p.toPlan}`;
    case 'downgrade_scheduled':
      return p.endsOn
        ? `Your plan changes to Schedura ${p.toPlan} on ${p.endsOn}`
        : `Your plan changes to Schedura ${p.toPlan} at the end of your billing period`;
    case 'cancel_scheduled':
      return p.endsOn
        ? `Your ${p.fromPlan} plan ends on ${p.endsOn}`
        : `Your ${p.fromPlan} plan is set to end`;
    case 'ended':
      return "You're on Schedura Free";
    case 'payment_restricted':
      return 'Your workspaces moved to Free';
  }
}

function subject(p: PlanChangedProps): string {
  switch (p.kind) {
    case 'upgraded':
    case 'downgraded':
      return `You're now on Schedura ${p.toPlan}`;
    case 'ended':
      return `Your Schedura ${p.fromPlan} plan has ended`;
    default:
      return heading(p);
  }
}

function preheader(p: PlanChangedProps): string {
  switch (p.kind) {
    case 'upgraded':
    case 'downgraded': {
      const next = p.nextCharge
        ? `Next charge on ${p.nextCharge}.`
        : `Your plan is now ${p.toPlan}.`;
      return p.showStripeReceipt
        ? `${next} Your receipt comes from Stripe.`
        : next;
    }
    case 'downgrade_scheduled':
    case 'cancel_scheduled':
      return `You keep ${p.fromPlan} until then.`;
    case 'ended':
      return 'Your workspaces are on Free. Nothing is deleted.';
    case 'payment_restricted':
      return 'Update your card to switch back.';
  }
}

function body(p: PlanChangedProps): string | null {
  const hasLimits = p.channels !== null && p.members !== null;
  switch (p.kind) {
    case 'upgraded': {
      const parts = [
        hasLimits
          ? `All ${p.channels} channels publish again, and your team can grow to ${p.members} members.`
          : null,
        p.showStripeReceipt ? STRIPE_RECEIPT : null,
      ].filter((part) => part !== null);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'downgraded':
      return hasLimits
        ? `Your workspaces now allow ${p.channels} channels and ${p.members} members.`
        : null;
    case 'downgrade_scheduled':
      return hasLimits
        ? `Until then you keep everything in ${p.fromPlan}. After that, your workspaces allow ${p.channels} channels and ${p.members} members.`
        : `Until then you keep everything in ${p.fromPlan}.`;
    case 'cancel_scheduled':
      return p.endsOn
        ? `Your workspaces move to Free on ${p.endsOn}. Nothing is deleted.`
        : 'Your workspaces move to Free when your billing period ends. Nothing is deleted.';
    case 'ended':
      return 'Your workspaces are now on Free. Nothing is deleted.';
    case 'payment_restricted':
      return `We couldn't collect payment for Schedura ${p.fromPlan} after 3 tries. Update your card to switch back.`;
  }
}

/** D3. One template for every way a plan changes; `kind` picks the copy. */
export const PLAN_CHANGED = defineTemplate<PlanChangedProps>({
  id: 'plan-changed',
  category: 'billing',
  event: null,
  footer: 'billing',
  subject,
  preheader,
  Body: (p) => {
    const text = body(p);
    const isChange =
      p.kind === 'upgraded' ||
      p.kind === 'downgraded' ||
      p.kind === 'downgrade_scheduled';
    const isRestriction = p.kind === 'payment_restricted';
    return (
      <>
        <Heading>{heading(p)}</Heading>
        {isChange ? (
          <DetailRows
            rows={[
              { label: 'Plan', value: `${p.fromPlan} → ${p.toPlan}` },
              ...(p.billed ? [{ label: 'Billed', value: p.billed }] : []),
              ...(p.nextCharge
                ? [{ label: 'Next charge', value: p.nextCharge }]
                : []),
              ...(p.kind === 'downgrade_scheduled' && p.endsOn
                ? [{ label: 'Changes on', value: p.endsOn }]
                : []),
            ]}
          />
        ) : null}
        {text ? <Paragraph>{text}</Paragraph> : null}
        <EmailButton
          href={p.billingUrl}
          variant={isRestriction ? 'primary' : 'secondary'}
        >
          {isRestriction ? 'Update card' : 'Manage billing'}
        </EmailButton>
      </>
    );
  },
  fixture: {
    kind: 'upgraded',
    fromPlan: 'Free',
    toPlan: 'Pro',
    billed: '$29 monthly',
    nextCharge: 'Nov 26, 2026',
    endsOn: null,
    channels: 8,
    members: 5,
    showStripeReceipt: true,
    billingUrl: BILLING_URL,
  },
  variants: {
    downgraded: {
      kind: 'downgraded',
      fromPlan: 'Pro',
      toPlan: 'Basic',
      billed: '$12 monthly',
      nextCharge: 'Nov 26, 2026',
      endsOn: null,
      channels: 5,
      members: 2,
      showStripeReceipt: false,
      billingUrl: BILLING_URL,
    },
    downgrade_scheduled: {
      kind: 'downgrade_scheduled',
      fromPlan: 'Pro',
      toPlan: 'Basic',
      billed: '$12 monthly',
      nextCharge: null,
      endsOn: 'Nov 26, 2026',
      channels: 5,
      members: 2,
      showStripeReceipt: false,
      billingUrl: BILLING_URL,
    },
    cancel_scheduled: {
      kind: 'cancel_scheduled',
      fromPlan: 'Pro',
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn: 'Nov 26, 2026',
      channels: null,
      members: null,
      showStripeReceipt: false,
      billingUrl: BILLING_URL,
    },
    ended: {
      kind: 'ended',
      fromPlan: 'Pro',
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn: null,
      channels: null,
      members: null,
      showStripeReceipt: false,
      billingUrl: BILLING_URL,
    },
    payment_restricted: {
      kind: 'payment_restricted',
      fromPlan: 'Pro',
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn: null,
      channels: null,
      members: null,
      showStripeReceipt: false,
      billingUrl: BILLING_URL,
    },
  },
});
