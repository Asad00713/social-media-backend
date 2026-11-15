import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { Quote } from '../../render/components/quote';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import { clipMessage, MessageText } from './message-text';

export interface ContactReceivedProps {
  /** `SCH-` plus 6 Crockford base32 characters. */
  reference: string;
  /** The topic's label, e.g. `Billing & refunds`. */
  topic: string;
  /** `formatWhen` output: 'Oct 26, 2026 at 10:42 AM UTC'. */
  sentAt: string;
  /** What the sender wrote; shown clipped to 1 000 characters. */
  message: string;
  /** Maestro has no deep link, so this is the app's front door. */
  maestroUrl: string;
}

/** The quote shows the start of a long message, not all 5 000 characters. */
export const MESSAGE_PREVIEW_CHARS = 1000;

/** E1: the acknowledgement to whoever used the contact form. */
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
      <Quote meta={`Your message · ${p.topic} · ${p.sentAt}`}>
        <MessageText text={clipMessage(p.message, MESSAGE_PREVIEW_CHARS)} />
      </Quote>
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
    topic: 'Publishing',
    sentAt: 'Oct 26, 2026 at 10:42 AM UTC',
    message:
      "Two of my Instagram posts failed this morning and I can't see why. The video is under a minute.",
    maestroUrl: 'https://app.schedura.ai/',
  },
});
