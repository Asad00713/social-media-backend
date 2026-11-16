import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface ContactReceivedProps {
  /** `SCH-` plus 6 Crockford base32 characters. */
  reference: string;
  /** Maestro has no deep link, so this is the app's front door. */
  maestroUrl: string;
}

/**
 * E1: the acknowledgement to whoever used the contact form. The form is
 * public, so the address may be a stranger's: nothing the sender typed is
 * echoed back, or the form would relay their text in Schedura's name.
 */
export const contactReceivedTemplate = defineTemplate<ContactReceivedProps>({
  id: 'contact-received',
  category: 'support',
  event: null,
  footer: 'plain',
  subject: (p) => `We got your message (#${p.reference})`,
  preheader: () => 'A person will reply within 1 business day.',
  footerReason: () => 'You get this because you contacted Schedura support.',
  extraFooterLinks: (links) => [{ label: 'Status', href: links.status() }],
  Body: (p) => (
    <>
      <Heading>We got your message</Heading>
      <Paragraph>
        A person on our team will reply within <Strong>1 business day</Strong>.
        Your reference is <Strong>{`#${p.reference}`}</Strong>.
      </Paragraph>
      <Callout tone="info">
        To add details or screenshots, reply to this email. It goes to the same
        conversation.
      </Callout>
      <Paragraph tone="muted">
        In the meantime, Maestro can answer most questions right away.
      </Paragraph>
      <EmailButton href={p.maestroUrl} variant="secondary">
        Ask Maestro
      </EmailButton>
    </>
  ),
  fixture: {
    reference: 'SCH-2481',
    maestroUrl: 'https://app.schedura.ai/',
  },
});
