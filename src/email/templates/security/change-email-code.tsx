import { CodeBox } from '../../render/components/code-box';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface ChangeEmailCodeProps {
  /** The 6-digit code, as typed (`305771`). */
  code: string;
  /** The address being confirmed; it is also the recipient. */
  newEmail: string;
}

/**
 * A3: the code that confirms a new sign-in email, sent to the NEW address.
 * Carries a one-time code, so it is sent inline (sendNow), never queued.
 */
export const changeEmailCodeTemplate = defineTemplate<ChangeEmailCodeProps>({
  id: 'change-email-code',
  category: 'security',
  event: null,
  footer: 'security',
  subject: (p) => `${p.code} is your code to change your email`,
  preheader: () => 'Enter it in Schedura to use this address for your account.',
  Body: (p) => (
    <>
      <Heading>Confirm your new email</Heading>
      <Paragraph>
        Enter this code in Schedura to start using <Strong>{p.newEmail}</Strong>{' '}
        for your account.
      </Paragraph>
      <CodeBox code={p.code} />
      <Paragraph tone="muted">
        The code expires in 10 minutes. If you didn't ask for this, ignore this
        email; nothing changes.
      </Paragraph>
    </>
  ),
  fixture: { code: '305771', newEmail: 'rehman@lumiere.cafe' },
});
