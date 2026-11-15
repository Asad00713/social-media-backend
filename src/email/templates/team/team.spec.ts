import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
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
  it('registers B1, B2 and B3 in the team group', () => {
    expect(TEAM_TEMPLATES.map((d) => d.id)).toEqual([
      'workspace-invitation',
      'invitation-accepted',
      'removed-from-workspace',
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
  });
});
