import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface LeadField {
  name: string;
  value: string;
}

export interface LeadDeliveredProps {
  formName: string;
  /** When the lead came in, in UTC (a form has no time zone). */
  capturedAt: string;
  leadId: string;
  fields: LeadField[];
}

/** Footer line 1, also used by the sender, which builds the footer itself. */
export function leadFooterReason(formName: string): string {
  return `You get this because new leads from ${formName} are set to email this address.`;
}

const FIXTURE: LeadDeliveredProps = {
  formName: 'Spring menu waitlist',
  capturedAt: 'Nov 12, 2026 at 10:42 AM UTC',
  leadId: '5d0b6f0e-1111-4222-8333-944455556666',
  fields: [
    { name: 'Full name', value: 'Sana Malik' },
    { name: 'Email', value: 'sana@lumierecafe.pk' },
    { name: 'Phone', value: '+92 300 1234567' },
  ],
};

/**
 * A lead from a Meta lead form, mailed to the address its route names. The
 * address comes from the route's config, so there is no preference to switch
 * it off (spec 4.2) and the footer is built by the sender.
 */
export const leadDelivered = defineTemplate<LeadDeliveredProps>({
  id: 'lead-delivered',
  category: 'leads',
  event: null,
  footer: 'plain',
  subject: (p) => `New lead captured: ${p.formName}`,
  preheader: (p) => `A new lead came in from ${p.formName}.`,
  footerReason: (p) => leadFooterReason(p.formName),
  Body: (p) => (
    <>
      <Heading>New lead captured</Heading>
      <Paragraph>{`Form: ${p.formName}`}</Paragraph>
      {p.fields.length > 0 ? (
        <DetailRows
          rows={p.fields.map((f) => ({ label: f.name, value: f.value }))}
        />
      ) : (
        <Paragraph tone="muted">This lead has no fields.</Paragraph>
      )}
      <Paragraph tone="muted">
        {`Captured ${p.capturedAt} · Lead ID ${p.leadId}`}
      </Paragraph>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    empty: { ...FIXTURE, fields: [] },
    unsafe: {
      ...FIXTURE,
      formName: '<script>x</script> & "Form"',
      fields: [
        { name: 'Na<me>', value: '<b>Sana</b> & "co"' },
        { name: 'Notes', value: 'long '.repeat(300) },
      ],
    },
  },
});
