import { CodeBox } from '../../render/components/code-box';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface AdminLoginCodeProps {
  /** The 6-digit code, as typed (`482913`). */
  code: string;
  /** Where the request came from, or null when unknown. */
  ip: string | null;
}

/** The admin dashboard's sign-in code. A one-time code, so it is sent inline (sendNow). */
export const adminLoginCodeTemplate = defineTemplate<AdminLoginCodeProps>({
  id: 'admin-login-code',
  category: 'security',
  event: null,
  footer: 'security',
  subject: (p) => `${p.code} is your Schedura admin sign-in code`,
  preheader: () => 'Enter it to finish signing in. It expires in 10 minutes.',
  Body: (p) => (
    <>
      <Heading>Your admin sign-in code</Heading>
      <Paragraph>
        Enter this code to finish signing in to the Schedura admin dashboard.
      </Paragraph>
      <CodeBox code={p.code} />
      <Paragraph tone="muted">
        {`The code expires in 10 minutes and can only be used once.${
          p.ip ? ` It was requested from ${p.ip}.` : ''
        }`}
      </Paragraph>
      <Paragraph tone="muted">
        If you didn’t try to sign in, someone has your password. Change it now.
      </Paragraph>
    </>
  ),
  fixture: { code: '482913', ip: '39.48.12.201' },
  variants: { 'no-ip': { code: '482913', ip: null } },
});
