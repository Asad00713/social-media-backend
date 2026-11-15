import { NOTIFICATION_EVENTS } from '../../../notification-preferences/notification-events';
import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
import { APPROVAL_NEEDED, type ApprovalNeededProps } from './approval-needed';
import {
  POST_APPROVED,
  firstName,
  type PostApprovedProps,
} from './post-approved';
import { PUBLISHING_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

const NASTY = 'A & <B> "q"';
const NASTY_ESCAPED = 'A &amp; &lt;B&gt; &quot;q&quot;';

describe('approval templates', () => {
  it('registers C3 and C4 in the publishing group', () => {
    const ids = PUBLISHING_TEMPLATES.map((d) => d.id);
    expect(ids).toContain('approval-needed');
    expect(ids).toContain('post-approved');
  });

  describe('C3 approval-needed', () => {
    const props: ApprovalNeededProps = APPROVAL_NEEDED.fixture;

    it('is a toggleable approval_request notification (the event is not locked)', () => {
      expect(APPROVAL_NEEDED.category).toBe('publishing');
      expect(APPROVAL_NEEDED.event).toBe('approval_request');
      expect(APPROVAL_NEEDED.footer).toBe('notification');
      expect(NOTIFICATION_EVENTS.approval_request.email?.locked).toBe(false);
      expect(NOTIFICATION_EVENTS.post_approved.email?.locked).toBe(false);
    });

    it('has the Figma subject, heading, facts, button and note, and no quote', async () => {
      const r = await renderEmail(APPROVAL_NEEDED, props, ctx);
      expect(r.subject).toBe('M Rehman asked you to approve a post');
      expect(r.html).toContain('M Rehman asked you to approve a post');
      expect(r.html).toContain('@lumierecafe');
      expect(r.html).toContain('Summer menu is here: iced caramel latte');
      expect(r.html).toContain('Campaign');
      expect(r.html).toContain('Summer menu');
      expect(r.html).toContain('Goes out');
      expect(r.html).toContain('Review post');
      expect(r.html).toContain('data-email-button="primary"');
      expect(r.html).toContain(props.reviewUrl);
      expect(r.html).toContain(
        'Approve or request changes in Schedura. It won&#x27;t publish until someone approves it.',
      );
      expect(r.html).not.toContain('Note from');
    });

    it('builds the preheader from network, time and campaign', () => {
      expect(APPROVAL_NEEDED.preheader(props)).toBe(
        'Instagram · Oct 26, 2026 at 6:30 PM GMT+5 · Summer menu',
      );
      expect(APPROVAL_NEEDED.preheader({ ...props, campaignName: null })).toBe(
        'Instagram · Oct 26, 2026 at 6:30 PM GMT+5',
      );
    });

    it('names the workspace in the footer reason', () => {
      expect(APPROVAL_NEEDED.footerReason?.(props)).toBe(
        'You get this because you approve posts in Rehman Workspace.',
      );
    });

    it('drops the campaign row when there is no campaign', async () => {
      const r = await renderEmail(
        APPROVAL_NEEDED,
        { ...props, campaignName: null },
        ctx,
      );
      expect(r.html).not.toContain('Campaign');
      expect(r.html).toContain('Goes out');
    });

    it('shows Not scheduled yet for a draft with no time', async () => {
      const r = await renderEmail(
        APPROVAL_NEEDED,
        APPROVAL_NEEDED.variants!['not-scheduled'],
        ctx,
      );
      expect(r.html).toContain('Not scheduled yet');
      expect(r.preheader).toBe('Instagram · Not scheduled yet');
    });

    it('escapes user-written text and keeps the subject on one line', async () => {
      const r = await renderEmail(
        APPROVAL_NEEDED,
        {
          ...props,
          requesterName: 'Eve\r\nBcc: x@y.z <i>',
          caption: `<script>alert(1)</script> ${NASTY}`,
          campaignName: NASTY,
          handle: NASTY,
        },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<script>');
      expect(r.html).not.toContain('<B>');
      expect(r.html).not.toContain('<i>');
      expect(r.subject).not.toMatch(/[\r\n]/);
    });

    it('truncates a 5000-character caption and reads (No caption) when blank', async () => {
      const long = await renderEmail(
        APPROVAL_NEEDED,
        { ...props, caption: 'x'.repeat(5000) },
        ctx,
      );
      expect(long.html).toContain(`${'x'.repeat(279)}…`);
      expect(long.html).not.toContain('x'.repeat(281));

      const blank = await renderEmail(
        APPROVAL_NEEDED,
        { ...props, caption: '   ' },
        ctx,
      );
      expect(blank.html).toContain('(No caption)');
    });

    it('shows the thumbnail when there is one', async () => {
      const r = await renderEmail(
        APPROVAL_NEEDED,
        { ...props, thumbnailUrl: 'https://cdn.test/a.jpg' },
        ctx,
      );
      expect(r.html).toContain('https://cdn.test/a.jpg');
    });
  });

  describe('C4 post-approved', () => {
    const props: PostApprovedProps = POST_APPROVED.fixture;

    it('is a toggleable post_approved notification using the default footer reason', () => {
      expect(POST_APPROVED.category).toBe('publishing');
      expect(POST_APPROVED.event).toBe('post_approved');
      expect(POST_APPROVED.footer).toBe('notification');
      // Figma: "You get this because Post approved -> Email is on for ..." is
      // the notification footer's own default line, so no override is set.
      expect(Object.hasOwn(POST_APPROVED, 'footerReason')).toBe(false);
      expect(NOTIFICATION_EVENTS.post_approved.label).toBe('Post approved');
    });

    it('has the Figma subject, heading, sentence and an outline Planner button', async () => {
      const r = await renderEmail(POST_APPROVED, props, ctx);
      expect(r.subject).toBe('Sana approved your post');
      expect(r.html).toContain('Sana approved your post');
      expect(r.html).toContain('@lumierecafe');
      expect(r.html).toContain(props.goesOutSentence);
      expect(r.html).toContain('View in Planner');
      expect(r.html).toContain('data-email-button="secondary"');
      expect(r.html).toContain(props.plannerUrl);
      expect(r.preheader).toBe(props.goesOutSentence);
    });

    it('says the post is ready to schedule when there is no time', async () => {
      const r = await renderEmail(
        POST_APPROVED,
        POST_APPROVED.variants!['not-scheduled'],
        ctx,
      );
      expect(r.html).toContain('It&#x27;s ready to schedule.');
      expect(r.html).toContain('Not scheduled yet');
    });

    it('uses the approver first name only', () => {
      expect(firstName('Sana Noor')).toBe('Sana');
      expect(firstName('  Sana  ')).toBe('Sana');
      expect(firstName('sana@lumierecafe.pk')).toBe('sana');
      expect(firstName('')).toBe('');
      expect(POST_APPROVED.subject({ ...props, approverName: 'A B' })).toBe(
        'A approved your post',
      );
    });

    it('escapes user-written text and keeps the subject on one line', async () => {
      const r = await renderEmail(
        POST_APPROVED,
        {
          ...props,
          approverName: 'Eve\r\nBcc: x@y.z',
          caption: `<script>alert(1)</script> ${NASTY}`,
          handle: NASTY,
        },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<script>');
      expect(r.subject).not.toMatch(/[\r\n]/);
    });

    it('truncates a long caption and reads (No caption) when blank', async () => {
      const long = await renderEmail(
        POST_APPROVED,
        { ...props, caption: 'y'.repeat(5000) },
        ctx,
      );
      expect(long.html).toContain(`${'y'.repeat(279)}…`);
      const blank = await renderEmail(
        POST_APPROVED,
        { ...props, caption: '' },
        ctx,
      );
      expect(blank.html).toContain('(No caption)');
    });
  });
});
