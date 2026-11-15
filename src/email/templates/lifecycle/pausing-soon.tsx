import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface PausingSoonProps {
  /** The pause day without the year: 'Nov 2'. */
  pauseDate: string;
  signInUrl: string;
}

/** F3: five days before the pause. The date and the one thing to do. */
export const pausingSoon = defineTemplate<PausingSoonProps>({
  id: 'pausing-soon',
  category: 'account',
  event: null,
  footer: 'account',
  subject: (p) => `Your Schedura account will be paused on ${p.pauseDate}`,
  preheader: () => 'Sign in before then to keep it active.',
  Body: (p) => (
    <>
      <Heading>{`Your account will be paused on ${p.pauseDate}`}</Heading>
      <Paragraph>
        {`You haven't signed in for 25 days. To keep your account active, sign in before ${p.pauseDate}.`}
      </Paragraph>
      <Callout tone="warning">
        While paused, scheduled posts stop publishing. Nothing is deleted.
      </Callout>
      <EmailButton href={p.signInUrl} variant="primary">
        Sign in to keep it active
      </EmailButton>
    </>
  ),
  fixture: { pauseDate: 'Nov 2', signInUrl: 'https://app.schedura.ai/login' },
});
