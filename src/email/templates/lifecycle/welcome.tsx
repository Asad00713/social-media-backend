import { EmailButton } from '../../render/components/button';
import { Steps } from '../../render/components/steps';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface WelcomeProps {
  /** The first word of the person's name, else `there`. */
  firstName: string;
  openUrl: string;
}

const STEPS = [
  {
    title: 'Connect a channel',
    body: 'Instagram, TikTok, LinkedIn and 8 more.',
  },
  {
    title: 'Plan your first post',
    body: 'Write once, adjust it per channel, pick a time.',
  },
  {
    title: 'Ask Maestro',
    body: 'Your assistant drafts a week of posts from one idea.',
  },
];

/** F1: after the email is verified. Three steps, not a feature tour. */
export const welcome = defineTemplate<WelcomeProps>({
  id: 'welcome',
  category: 'lifecycle',
  event: null,
  footer: 'plain',
  subject: () => 'Welcome to Schedura',
  preheader: () => 'Three things to do first. About 5 minutes.',
  footerReason: () => 'You get this because you created a Schedura account.',
  Body: (p) => (
    <>
      <Heading>{`Welcome to Schedura, ${p.firstName}`}</Heading>
      <Paragraph>
        Here’s the quickest way to your first scheduled post.
      </Paragraph>
      <Steps steps={STEPS} />
      <EmailButton href={p.openUrl} variant="primary">
        Open Schedura
      </EmailButton>
      <Paragraph tone="muted">
        Questions? Reply to this email. A person reads it.
      </Paragraph>
    </>
  ),
  fixture: { firstName: 'Rehman', openUrl: 'https://app.schedura.ai/' },
  variants: {
    'no-name': { firstName: 'there', openUrl: 'https://app.schedura.ai/' },
  },
});
