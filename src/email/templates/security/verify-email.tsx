import { CodeBox } from '../../render/components/code-box';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface VerifyEmailProps {
  /** The 6-digit sign-up code, as typed (`482913`). */
  code: string;
  /** The address that signed up; it is also the recipient. */
  email: string;
}

/** A1: the sign-up code. Carries a one-time code, so it is sent inline (sendNow). */
export const verifyEmailTemplate = defineTemplate<VerifyEmailProps>({
  id: 'verify-email',
  category: 'security',
  event: null,
  footer: 'plain',
  subject: (p) => `${p.code} is your Schedura code`,
  preheader: () => 'Enter it to verify your email. It expires in 10 minutes.',
  footerReason: (p) =>
    `You get this because someone signed up for Schedura with ${p.email}.`,
  Body: (p) => (
    <>
      <Heading>Verify your email</Heading>
      <Paragraph>
        Enter this code in Schedura to finish creating your account.
      </Paragraph>
      <CodeBox code={p.code} />
      <Paragraph tone="muted">
        The code expires in 10 minutes. If you didn't create a Schedura account,
        you can ignore this email.
      </Paragraph>
    </>
  ),
  fixture: { code: '482913', email: 'rehman@lumierecafe.pk' },
});
