import type { ConfigService } from '@nestjs/config';
import { AppLinks } from '../../links/app-links';
import { renderEmail } from '../../render/render-email';
import { adminLoginCodeTemplate } from '../security/admin-login-code';
import { SECURITY_TEMPLATES } from '../security';
import type { RenderContext } from '../types';
import {
  contactReceivedTemplate,
  type ContactReceivedProps,
} from './contact-received';
import {
  contactEnquiryTemplate,
  type ContactEnquiryProps,
} from './contact-enquiry';
import { SUPPORT_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

const ack: ContactReceivedProps = contactReceivedTemplate.fixture;
const enquiry: ContactEnquiryProps = contactEnquiryTemplate.fixture;

describe('support templates', () => {
  it('registers E1 and the enquiry in the support group', () => {
    expect(SUPPORT_TEMPLATES.map((d) => d.id)).toEqual([
      'contact-received',
      'contact-enquiry',
    ]);
  });

  describe('E1 contact-received', () => {
    it('is mandatory mail with a plain footer in the support category', () => {
      expect(contactReceivedTemplate.category).toBe('support');
      // A notification footer would need a catalogue event; E1 has none.
      expect(contactReceivedTemplate.event).toBeNull();
      expect(contactReceivedTemplate.footer).toBe('plain');
      expect(contactReceivedTemplate.footerReason?.(ack)).toBe(
        'You get this because you contacted Schedura support.',
      );
    });

    it('adds Status after Help center, from AppLinks', () => {
      const links = new AppLinks({
        get: (key: string) =>
          key === 'MARKETING_URL' ? 'https://schedura.test' : undefined,
      } as unknown as ConfigService);
      const extra = contactReceivedTemplate.extraFooterLinks;
      expect(typeof extra).toBe('function');
      expect(typeof extra === 'function' ? extra(links) : extra).toEqual([
        { label: 'Status', href: 'https://schedura.test/status' },
      ]);
    });

    it('has the Figma subject, preheader and copy', async () => {
      const r = await renderEmail(contactReceivedTemplate, ack, ctx);
      expect(r.subject).toBe('We got your message (#SCH-2481)');
      expect(r.preheader).toBe('A person will reply within 1 business day.');
      expect(r.text).toContain('We got your message');
      expect(r.text).toContain(
        'A person on our team will reply within 1 business day. Your reference is #SCH-2481.',
      );
      expect(r.text).toContain(
        'Your message · Publishing · Oct 26, 2026 at 10:42 AM UTC',
      );
      expect(r.text).toContain(
        'To add details or screenshots, reply to this email. It goes to the same conversation.',
      );
      expect(r.text).toContain(
        'In the meantime, Maestro can answer most questions right away.',
      );
    });

    it('has one outline button, Ask Maestro, to the app', async () => {
      const r = await renderEmail(contactReceivedTemplate, ack, ctx);
      expect(r.html.match(/data-email-button="secondary"/g)).toHaveLength(1);
      expect(r.html).not.toContain('data-email-button="primary"');
      expect(r.html).toContain('href="https://app.schedura.ai/"');
      expect(r.text).toContain('Ask Maestro');
    });

    it('shows at most 1 000 characters of the message, ending in an ellipsis', async () => {
      const r = await renderEmail(
        contactReceivedTemplate,
        { ...ack, message: 'x'.repeat(5000) },
        ctx,
      );
      expect(r.html).toContain(`${'x'.repeat(999)}…`);
      expect(r.html).not.toContain('x'.repeat(1000));
    });

    it('leaves a message of exactly 1 000 characters whole', async () => {
      const r = await renderEmail(
        contactReceivedTemplate,
        { ...ack, message: 'y'.repeat(1000) },
        ctx,
      );
      expect(r.html).toContain('y'.repeat(1000));
      expect(r.html).not.toContain('…');
    });

    it('escapes the message and topic', async () => {
      const r = await renderEmail(
        contactReceivedTemplate,
        { ...ack, topic: '<u>T</u>', message: '<b>hi</b>' },
        ctx,
      );
      expect(r.html).not.toContain('<b>hi</b>');
      expect(r.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
      expect(r.html).not.toContain('<u>T</u>');
    });

    it('keeps the message line breaks', async () => {
      const r = await renderEmail(
        contactReceivedTemplate,
        { ...ack, message: 'one\r\ntwo' },
        ctx,
      );
      expect(r.html).toMatch(/one<br\/?>two/);
    });
  });

  describe('contact-enquiry', () => {
    it('is mandatory mail with a plain footer', () => {
      expect(contactEnquiryTemplate.category).toBe('support');
      expect(contactEnquiryTemplate.event).toBeNull();
      expect(contactEnquiryTemplate.footer).toBe('plain');
      expect(contactEnquiryTemplate.footerReason?.(enquiry)).toBeTruthy();
    });

    it('has the subject [topic] name · #reference on one line', async () => {
      const r = await renderEmail(
        contactEnquiryTemplate,
        { ...enquiry, name: 'Ada\r\nBcc: x@evil.test' },
        ctx,
      );
      expect(r.subject).toBe('[Publishing] Ada Bcc: x@evil.test · #SCH-2481');
      expect(r.subject).not.toMatch(/[\r\n]/);
    });

    it('shows every field, and the company only when there is one', async () => {
      const full = await renderEmail(contactEnquiryTemplate, enquiry, ctx);
      expect(full.text).toContain('Rehman Khan');
      expect(full.text).toContain('rehman@lumierecafe.pk');
      expect(full.text).toContain('Lumiere Cafe');
      expect(full.text).toContain('#SCH-2481');

      const bare = await renderEmail(
        contactEnquiryTemplate,
        { ...enquiry, company: null },
        ctx,
      );
      expect(bare.text).not.toContain('Company');
    });

    it('caps a long name in the quote meta as in the subject', async () => {
      const r = await renderEmail(
        contactEnquiryTemplate,
        { ...enquiry, name: 'N'.repeat(200) },
        ctx,
      );
      expect(r.html).toContain(`${'N'.repeat(80)} · Publishing`);
      expect(r.html).not.toContain('N'.repeat(81) + ' ·');
    });

    it('escapes every sender-supplied field', async () => {
      const r = await renderEmail(
        contactEnquiryTemplate,
        {
          ...enquiry,
          name: '<b>N</b>',
          email: '<b>E</b>',
          company: '<b>C</b>',
          message: '<b>hi</b>',
        },
        ctx,
      );
      expect(r.html).not.toContain('<b>');
      expect(r.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    });
  });
});

describe('admin-login-code', () => {
  it('is registered with the security group, mandatory, security footer', () => {
    expect(SECURITY_TEMPLATES).toContain(adminLoginCodeTemplate);
    expect(adminLoginCodeTemplate.category).toBe('security');
    expect(adminLoginCodeTemplate.event).toBeNull();
    expect(adminLoginCodeTemplate.footer).toBe('security');
  });

  it('puts the code in the subject and a code box, with no button', async () => {
    const r = await renderEmail(
      adminLoginCodeTemplate,
      adminLoginCodeTemplate.fixture,
      ctx,
    );
    expect(r.subject).toBe('482913 is your Schedura admin sign-in code');
    expect(r.html).toContain('482 913');
    expect(r.html).not.toContain('data-email-button');
    expect(r.text).toContain(
      'The code expires in 10 minutes and can only be used once. It was requested from 39.48.12.201.',
    );
  });

  it('omits the request address when it is unknown', async () => {
    const r = await renderEmail(
      adminLoginCodeTemplate,
      { code: '482913', ip: null },
      ctx,
    );
    expect(r.text).not.toContain('requested from');
  });
});
