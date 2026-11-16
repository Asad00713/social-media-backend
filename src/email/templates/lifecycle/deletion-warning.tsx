import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface DeletionWarningProps {
  /** The deletion day without the year: 'Dec 1'. */
  deleteOn: string;
  /** The same day with the year: 'Dec 1, 2026'. */
  deleteOnLong: string;
  signInUrl: string;
  supportEmail: string;
}

/**
 * F5: 30 days before a paused account is deleted. "11 months" is policy, not
 * a prop: the account was paused at day 30 and is deleted a year later.
 */
export const deletionWarning = defineTemplate<DeletionWarningProps>({
  id: 'deletion-warning',
  category: 'account',
  event: null,
  footer: 'account',
  subject: (p) => `Your Schedura account will be deleted on ${p.deleteOn}`,
  preheader: () => 'Sign in before then to keep your workspace and posts.',
  Body: (p) => (
    <>
      <Heading>{`Your account will be deleted on ${p.deleteOn}`}</Heading>
      <Paragraph>
        {`Your account has been paused for 11 months. On ${p.deleteOnLong} we’ll permanently delete it.`}
      </Paragraph>
      <Callout tone="danger">
        This deletes your workspace, posts, drafts, media and analytics. It
        can’t be undone.
      </Callout>
      <EmailButton href={p.signInUrl} variant="primary">
        Keep my account
      </EmailButton>
      <Paragraph tone="muted">
        {`Want a copy first? Sign in and export it from Settings → Workspace. Questions? Write to ${p.supportEmail}.`}
      </Paragraph>
    </>
  ),
  fixture: {
    deleteOn: 'Dec 1',
    deleteOnLong: 'Dec 1, 2026',
    signInUrl: 'https://app.schedura.ai/login',
    supportEmail: 'support@schedura.ai',
  },
});
