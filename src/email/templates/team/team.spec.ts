import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
import {
  channelConnectLink,
  formatLinkExpiry,
  formatNetworkList,
} from './channel-connect-link';
import {
  invitationAccepted,
  type InvitationAcceptedProps,
} from './invitation-accepted';
import {
  removedFromWorkspace,
  type RemovedProps,
} from './removed-from-workspace';
import {
  ROLE_EMAIL_LINE,
  workspaceInvitation,
  type InvitationProps,
} from './workspace-invitation';
import { TEAM_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

const NASTY = 'A & <B> "q"';
const NASTY_ESCAPED = 'A &amp; &lt;B&gt; &quot;q&quot;';

describe('team templates', () => {
  it('registers B1, B2, B3 and the connect link in the team group', () => {
    expect(TEAM_TEMPLATES.map((d) => d.id)).toEqual([
      'workspace-invitation',
      'invitation-accepted',
      'removed-from-workspace',
      'channel-connect-link',
    ]);
  });

  describe('ROLE_EMAIL_LINE', () => {
    it('names the product roles, not Figma "Editor" (spec 4.4 item 6)', () => {
      expect(ROLE_EMAIL_LINE).toEqual({
        ADMIN: 'Admin · manage members, channels and approvals',
        MEMBER: 'Member · create, schedule and publish',
        GUEST: 'Viewer · draft posts and view the workspace',
      });
    });
  });

  describe('B1 workspace-invitation', () => {
    const props: InvitationProps = workspaceInvitation.fixture;

    it('is mandatory mail with a plain footer naming inviter and invitee', () => {
      expect(workspaceInvitation.category).toBe('team');
      expect(workspaceInvitation.event).toBeNull();
      expect(workspaceInvitation.footer).toBe('plain');
      expect(workspaceInvitation.footerReason?.(props)).toBe(
        `You get this because ${props.inviterName} invited ${props.inviteeEmail}.`,
      );
    });

    it('has the Figma subject, preheader and the accept button', async () => {
      const r = await renderEmail(workspaceInvitation, props, ctx);
      expect(r.subject).toBe(
        'M Rehman invited you to Rehman Workspace on Schedura',
      );
      expect(r.preheader).toBe(
        'Join as a Member to plan and publish posts together.',
      );
      expect(r.html).toContain('Join Rehman Workspace on Schedura');
      expect(r.html).toContain('Accept invitation');
      expect(r.html).toContain(props.acceptUrl.replace(/&/g, '&amp;'));
      expect(r.html).toContain('8 connected');
      expect(r.html).toContain('3 people');
      expect(r.html).toContain('sana@lumierecafe.pk');
      expect(r.html).toContain('expires in 7 days.');
    });

    it('renders a GUEST role as Viewer with its line', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        { ...props, role: 'GUEST' },
        ctx,
      );
      expect(r.html).toContain('Viewer · draft posts and view the workspace');
      expect(r.preheader).toBe(
        'Join as a Viewer to plan and publish posts together.',
      );
      expect(r.html).not.toContain('Editor');
      expect(r.html).not.toContain('Guest');
    });

    it('uses "an" before Admin and "1 person" for a lone member', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        { ...props, role: 'ADMIN', members: 1 },
        ctx,
      );
      expect(r.preheader).toBe(
        'Join as an Admin to plan and publish posts together.',
      );
      expect(r.html).toContain('1 person');
    });

    it('leaves out the empty parentheses when the inviter has no email', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        { ...props, inviterName: 'A teammate', inviterEmail: '' },
        ctx,
      );
      expect(r.html).toContain('A teammate');
      expect(r.html).not.toContain('()');
      expect(r.html).not.toContain('( )');
      expect(r.text).toContain('A teammate invited you to');
    });

    it('shows the inviter email in parentheses when known', async () => {
      const r = await renderEmail(workspaceInvitation, props, ctx);
      expect(r.text).toContain(
        'M Rehman (rehman@lumierecafe.pk) invited you to',
      );
    });

    it('renders the personal note as a quote from the inviter', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        { ...props, message: 'We need you on the October launch.' },
        ctx,
      );
      expect(r.html).toContain('M Rehman wrote');
      expect(r.html).toContain('We need you on the October launch.');
      expect(r.text).toContain('We need you on the October launch.');
    });

    it('escapes the personal note: markup in it is text, never HTML', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        { ...props, message: '<b>hi</b>' },
        ctx,
      );
      expect(r.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
      expect(r.html).not.toContain('<b>hi</b>');
    });

    it.each([null, ''])(
      'no note (%p) renders no quote block',
      async (message) => {
        const r = await renderEmail(
          workspaceInvitation,
          { ...props, message },
          ctx,
        );
        expect(r.html).not.toContain(' wrote');
        expect(r.html).not.toContain('border-left');
      },
    );

    it('escapes user-written names and keeps the subject on one line', async () => {
      const r = await renderEmail(
        workspaceInvitation,
        {
          ...props,
          workspaceName: NASTY,
          inviterName: 'Eve\r\nBcc: x@y.z <i>',
        },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
      expect(r.html).not.toContain('<i>');
      expect(r.subject).not.toMatch(/[\r\n]/);
    });
  });

  describe('B2 invitation-accepted', () => {
    const props: InvitationAcceptedProps = invitationAccepted.fixture;

    it('is a toggleable member_activity notification', () => {
      expect(invitationAccepted.category).toBe('team');
      expect(invitationAccepted.event).toBe('member_activity');
      expect(invitationAccepted.footer).toBe('notification');
    });

    it('has the Figma subject, facts and an outline button', async () => {
      const r = await renderEmail(invitationAccepted, props, ctx);
      expect(r.subject).toBe('Sana Noor joined Rehman Workspace');
      expect(r.html).toContain('sana@lumierecafe.pk');
      expect(r.html).toContain('Oct 26, 2026');
      expect(r.html).toContain('Manage members');
      expect(r.html).toContain('data-email-button="secondary"');
    });

    it.each([
      ['ADMIN', 'They can now manage the workspace as an Admin.'],
      ['MEMBER', 'They can now create and schedule posts as a Member.'],
      ['GUEST', 'They can now draft posts and view the workspace as a Viewer.'],
    ] as const)('preheader for %s', (role, expected) => {
      expect(invitationAccepted.preheader({ ...props, role })).toBe(expected);
    });

    it('escapes a name and workspace with markup', async () => {
      const r = await renderEmail(
        invitationAccepted,
        { ...props, memberName: NASTY, workspaceName: NASTY },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
    });
  });

  describe('B3 removed-from-workspace', () => {
    const props: RemovedProps = removedFromWorkspace.fixture;

    it('is mandatory mail with the plain "access changed" footer', () => {
      expect(removedFromWorkspace.category).toBe('team');
      expect(removedFromWorkspace.event).toBeNull();
      expect(removedFromWorkspace.footer).toBe('plain');
      expect(removedFromWorkspace.footerReason?.(props)).toBe(
        'You get this because your access to a workspace changed.',
      );
    });

    it('says who removed you and what happens to your work', async () => {
      const r = await renderEmail(removedFromWorkspace, props, ctx);
      expect(r.subject).toBe('You no longer have access to Rehman Workspace');
      expect(r.preheader).toBe('Posts you created stay in the workspace.');
      expect(r.html).toContain('M Rehman');
      expect(r.html).toContain('Oct 26, 2026');
      expect(r.html).toContain(
        'Posts and drafts you created stay in the workspace.',
      );
      expect(r.html).toContain(
        'Your Schedura account is still active. You can create your own workspace or join another one.',
      );
      expect(r.html).toContain('Open Schedura');
    });

    it('escapes the workspace and remover names', async () => {
      const r = await renderEmail(
        removedFromWorkspace,
        { ...props, workspaceName: NASTY, removedByName: NASTY },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
    });

    describe('stillApplies: sent only for the removal it announces', () => {
      const REMOVED_AT = props.removedAtMs;

      function guardDb(
        row: { status: string; removedAt: Date | null } | undefined,
      ) {
        const findFirst = jest.fn().mockResolvedValue(row);
        return {
          findFirst,
          deps: {
            db: { query: { workspaceInvitation: { findFirst } } } as never,
          },
        };
      }

      it('sends while the row is still REMOVED by that same removal', async () => {
        const { deps, findFirst } = guardDb({
          status: 'REMOVED',
          removedAt: new Date(REMOVED_AT),
        });
        await expect(
          removedFromWorkspace.stillApplies?.(props, deps),
        ).resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledTimes(1);
      });

      it('skips a member restored inside the undo window', async () => {
        const { deps } = guardDb({ status: 'ACCEPTED', removedAt: null });
        await expect(
          removedFromWorkspace.stillApplies?.(props, deps),
        ).resolves.toBe(false);
      });

      it('skips when they were restored and removed again: a later removal sends its own', async () => {
        const { deps } = guardDb({
          status: 'REMOVED',
          removedAt: new Date(REMOVED_AT + 60_000),
        });
        await expect(
          removedFromWorkspace.stillApplies?.(props, deps),
        ).resolves.toBe(false);
      });

      it('skips a row that no longer exists', async () => {
        const { deps } = guardDb(undefined);
        await expect(
          removedFromWorkspace.stillApplies?.(props, deps),
        ).resolves.toBe(false);
      });
    });
  });

  describe('channel-connect-link', () => {
    const props = channelConnectLink.fixture;

    it('is mandatory mail with a plain footer naming sender and recipient', () => {
      expect(channelConnectLink.category).toBe('team');
      expect(channelConnectLink.event).toBeNull();
      expect(channelConnectLink.footer).toBe('plain');
      expect(channelConnectLink.footerReason?.(props)).toBe(
        'You get this because M Rehman sent a connect link to client@lumierecafe.pk.',
      );
    });

    it('names the sender, the networks and the link, and says no account is needed', async () => {
      const r = await renderEmail(channelConnectLink, props, ctx);
      expect(r.subject).toBe(
        'M Rehman asked you to connect Instagram, Facebook and TikTok to Rehman Workspace',
      );
      expect(r.html).toContain('Connect your accounts');
      expect(r.html).toContain(props.connectUrl);
      expect(r.text).toContain(
        'asked you to connect your Instagram, Facebook and TikTok to their workspace on Schedura.',
      );
      expect(r.text).toContain('works until November 20, 2026 (UTC)');
      expect(r.text).toContain('no Schedura account or password needed');
    });

    it('states the expiry as a UTC date, labelled UTC, whatever the server time zone', () => {
      // 23:30 UTC on Nov 20: already Nov 21 east of UTC, still Nov 20 in UTC
      expect(formatLinkExpiry(new Date('2026-11-20T23:30:00Z'))).toBe(
        'November 20, 2026 (UTC)',
      );
    });

    it('lists networks by name, X for twitter', () => {
      expect(formatNetworkList(['instagram'])).toBe('Instagram');
      expect(formatNetworkList(['twitter', 'threads'])).toBe('X and Threads');
    });

    it('escapes the sender and workspace names', async () => {
      const r = await renderEmail(
        channelConnectLink,
        { ...props, senderName: NASTY, workspaceName: NASTY },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
      expect(r.subject).not.toMatch(/[\r\n]/);
    });
  });
});
