import { NOTIFICATION_EVENTS } from '../../../notification-preferences/notification-events';
import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
import { accountPaused } from './account-paused';
import { deletionWarning } from './deletion-warning';
import { inactiveReminder } from './inactive-reminder';
import { pausingSoon } from './pausing-soon';
import { welcome } from './welcome';
import { LIFECYCLE_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

const NASTY = 'A & <B> "q"';
const NASTY_ESCAPED = 'A &amp; &lt;B&gt; &quot;q&quot;';

describe('lifecycle templates', () => {
  it('registers F1 to F5 in the lifecycle group', () => {
    expect(LIFECYCLE_TEMPLATES.map((d) => d.id)).toEqual([
      'welcome',
      'inactive-reminder',
      'pausing-soon',
      'account-paused',
      'deletion-warning',
    ]);
  });

  it('a notification footer is never mapped to a locked or missing event', () => {
    for (const def of LIFECYCLE_TEMPLATES) {
      if (def.footer !== 'notification') continue;
      const event =
        def.event === null
          ? undefined
          : NOTIFICATION_EVENTS[def.event as keyof typeof NOTIFICATION_EVENTS];
      expect(event?.email?.locked).toBe(false);
    }
  });

  it('no lifecycle template carries a placeholder support address or an emoji', async () => {
    for (const def of LIFECYCLE_TEMPLATES) {
      const r = await renderEmail(def, def.fixture, ctx);
      expect(r.html).not.toContain('yourdomain');
      expect(r.subject).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(r.html).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  describe('F1 welcome', () => {
    it('is one-off lifecycle mail with its own footer sentence', () => {
      expect(welcome.category).toBe('lifecycle');
      expect(welcome.event).toBeNull();
      expect(welcome.footer).toBe('plain');
      expect(welcome.footerReason?.(welcome.fixture)).toBe(
        'You get this because you created a Schedura account.',
      );
    });

    it('has the Figma subject, heading, three steps and the open button', async () => {
      const r = await renderEmail(welcome, welcome.fixture, ctx);
      expect(r.subject).toBe('Welcome to Schedura');
      expect(welcome.preheader(welcome.fixture)).toBe(
        'Three things to do first. About 5 minutes.',
      );
      expect(r.html).toContain('Welcome to Schedura, Rehman');
      expect(r.html).toContain('Connect a channel');
      expect(r.html).toContain('Plan your first post');
      expect(r.html).toContain('Ask Maestro');
      expect(r.html).toContain('Open Schedura');
      expect(r.html).toContain('href="https://app.schedura.ai/"');
      expect(r.html).toContain('Reply to this email');
    });

    it('escapes a name written as markup', async () => {
      const r = await renderEmail(
        welcome,
        { ...welcome.fixture, firstName: NASTY },
        ctx,
      );
      expect(r.html).toContain(`Welcome to Schedura, ${NASTY_ESCAPED}`);
      expect(r.html).not.toContain('<B>');
    });
  });

  describe('F2 inactive-reminder', () => {
    const props = inactiveReminder.fixture;

    it('is the account-level reminder with a plain footer naming the 15 days', () => {
      expect(inactiveReminder.category).toBe('lifecycle');
      expect(inactiveReminder.event).toBe('inactivity_reminder');
      expect(inactiveReminder.footer).toBe('plain');
      expect(inactiveReminder.footerReason?.(props)).toBe(
        "You get this because you haven't signed in for 15 days.",
      );
      expect(NOTIFICATION_EVENTS.inactivity_reminder.email?.locked).toBe(false);
    });

    it('says what is waiting, with "Nothing this week" for 0 scheduled', async () => {
      const r = await renderEmail(inactiveReminder, props, ctx);
      expect(r.subject).toBe('Your channels are still connected');
      expect(inactiveReminder.preheader(props)).toBe(
        '8 channels and 3 drafts are waiting in Rehman Workspace.',
      );
      expect(r.html).toContain('Your workspace is ready when you are');
      expect(r.html).toContain('8 connected');
      expect(r.html).toContain('Nothing this week');
    });

    it('counts scheduled posts, and singularises one channel and one draft', async () => {
      const p = inactiveReminder.variants!.scheduled;
      const r = await renderEmail(inactiveReminder, p, ctx);
      expect(r.html).toContain('4 this week');
      expect(r.html).not.toContain('Nothing this week');
      expect(inactiveReminder.preheader(p)).toBe(
        '1 channel and 1 draft are waiting in Rehman Workspace.',
      );
    });

    it('does not claim "0 channels and 0 drafts are waiting"', () => {
      expect(inactiveReminder.preheader(inactiveReminder.variants!.empty)).toBe(
        'Pick up where you left off in Rehman Workspace.',
      );
    });

    it('escapes a workspace name written as markup', async () => {
      const r = await renderEmail(
        inactiveReminder,
        { ...props, workspaceName: NASTY },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
    });
  });

  describe('F3 to F5 account mail', () => {
    it.each([
      ['pausing-soon', pausingSoon],
      ['account-paused', accountPaused],
      ['deletion-warning', deletionWarning],
    ])('%s cannot be turned off', (_id, def) => {
      expect(def.category).toBe('account');
      expect(def.event).toBeNull();
      expect(def.footer).toBe('account');
    });

    it('F3 names the pause date in subject, heading and body', async () => {
      const p = pausingSoon.fixture;
      const r = await renderEmail(pausingSoon, p, ctx);
      expect(r.subject).toBe('Your Schedura account will be paused on Nov 2');
      expect(pausingSoon.preheader(p)).toBe(
        'Sign in before then to keep it active.',
      );
      expect(r.html).toContain('Your account will be paused on Nov 2');
      expect(r.html).toContain(
        'You haven&#x27;t signed in for 25 days. To keep your account active, sign in before Nov 2.',
      );
      expect(r.html).toContain(
        'While paused, scheduled posts stop publishing. Nothing is deleted.',
      );
      expect(r.html).toContain('Sign in to keep it active');
    });

    it('F4 lists what is kept and both dates, and gives the support address', async () => {
      const p = accountPaused.fixture;
      const r = await renderEmail(accountPaused, p, ctx);
      expect(r.subject).toBe('Your Schedura account is paused');
      expect(accountPaused.preheader(p)).toBe(
        'Everything is kept. Sign in to pick up where you left off.',
      );
      expect(r.html).toContain('Posts, drafts, media and channels');
      expect(r.html).toContain('Nov 2, 2026');
      expect(r.html).toContain('Nov 2, 2027, if you don&#x27;t come back');
      expect(r.html).toContain('Sign in to reactivate');
      expect(r.html).toContain('Questions? Write to support@schedura.ai.');
    });

    it('F5 states the date, what is lost, and the SUPPORT_EMAIL value, never yourdomain', async () => {
      const p = {
        ...deletionWarning.fixture,
        supportEmail: 'help@custom.example',
      };
      const r = await renderEmail(deletionWarning, p, ctx);
      expect(r.subject).toBe('Your Schedura account will be deleted on Dec 1');
      expect(deletionWarning.preheader(p)).toBe(
        'Sign in before then to keep your workspace and posts.',
      );
      expect(r.html).toContain('Your account will be deleted on Dec 1');
      expect(r.html).toContain(
        'On Dec 1, 2026 we&#x27;ll permanently delete it.',
      );
      expect(r.html).toContain(
        'This deletes your workspace, posts, drafts, media and analytics.',
      );
      expect(r.html).toContain('Keep my account');
      expect(r.html).toContain('help@custom.example');
      expect(r.html).not.toContain('yourdomain');
      expect(r.text).toContain('help@custom.example');
    });
  });
});
