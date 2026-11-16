import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface AccountPausedProps {
  /** Both dates with the year: 'Nov 2, 2026'. */
  pausedSince: string;
  deleteOn: string;
  signInUrl: string;
  supportEmail: string;
}

/** F4: the account is paused. Says what is kept and the deletion date. */
export const accountPaused = defineTemplate<AccountPausedProps>({
  id: 'account-paused',
  category: 'account',
  event: null,
  footer: 'account',
  subject: () => 'Your Schedura account is paused',
  preheader: () => 'Everything is kept. Sign in to pick up where you left off.',
  Body: (p) => (
    <>
      <Heading>Your account is paused</Heading>
      <Paragraph>
        Nobody signed in for 30 days, so we paused your account and scheduled
        posts stopped.
      </Paragraph>
      <DetailRows
        rows={[
          { label: 'Kept', value: 'Posts, drafts, media and channels' },
          { label: 'Paused since', value: p.pausedSince },
          {
            label: 'Deleted on',
            value: `${p.deleteOn}, if you don’t come back`,
          },
        ]}
      />
      <EmailButton href={p.signInUrl} variant="primary">
        Sign in to reactivate
      </EmailButton>
      <Paragraph tone="muted">{`Questions? Write to ${p.supportEmail}.`}</Paragraph>
    </>
  ),
  fixture: {
    pausedSince: 'Nov 2, 2026',
    deleteOn: 'Nov 2, 2027',
    signInUrl: 'https://app.schedura.ai/login',
    supportEmail: 'support@schedura.ai',
  },
});
