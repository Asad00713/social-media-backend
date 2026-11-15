import { DetailRows } from '../../render/components/detail-rows';
import { Quote } from '../../render/components/quote';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import { MessageText } from './message-text';

export interface ContactEnquiryProps {
  /** `SCH-` plus 6 Crockford base32 characters; it also threads replies. */
  reference: string;
  /** The topic's label, e.g. `Billing & refunds`. */
  topic: string;
  name: string;
  /** The sender's address; it is also the Reply-To. */
  email: string;
  company: string | null;
  message: string;
}

/** The subject shows a sender's name, which they typed: keep it short. */
const SUBJECT_NAME_CHARS = 80;

/** One header line, whatever the sender put in their name. */
function subjectName(name: string): string {
  return Array.from(name.replace(/\s+/g, ' ').trim())
    .slice(0, SUBJECT_NAME_CHARS)
    .join('');
}

/** What a contact-form submission looks like in our own inbox (to us). */
export const contactEnquiryTemplate = defineTemplate<ContactEnquiryProps>({
  id: 'contact-enquiry',
  category: 'support',
  event: null,
  footer: 'plain',
  subject: (p) => `[${p.topic}] ${subjectName(p.name)} · #${p.reference}`,
  preheader: (p) => `New message from the contact form · #${p.reference}`,
  footerReason: () => 'You get this because someone used the contact form.',
  Body: (p) => (
    <>
      <Heading>New contact enquiry</Heading>
      <DetailRows
        rows={[
          { label: 'Reference', value: `#${p.reference}` },
          { label: 'Topic', value: p.topic },
          { label: 'Name', value: p.name },
          { label: 'Email', value: p.email },
          ...(p.company ? [{ label: 'Company', value: p.company }] : []),
        ]}
      />
      <Quote meta={`${p.name} · ${p.topic}`}>
        <MessageText text={p.message} />
      </Quote>
      <Paragraph tone="muted">
        Reply to this email and it goes straight to the sender.
      </Paragraph>
    </>
  ),
  fixture: {
    reference: 'SCH-2481',
    topic: 'Publishing',
    name: 'Rehman Khan',
    email: 'rehman@lumierecafe.pk',
    company: 'Lumiere Cafe',
    message:
      "Two of my Instagram posts failed this morning and I can't see why.\nThe video is under a minute.",
  },
  variants: {
    'no-company': {
      reference: 'SCH-7QK2M9',
      topic: 'Billing & refunds',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: null,
      message: 'I was charged twice for the same period.',
    },
  },
});
