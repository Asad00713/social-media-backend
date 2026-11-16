import { DetailRows } from '../../render/components/detail-rows';
import { EmailButton } from '../../render/components/button';
import { FallbackLink } from '../../render/components/fallback-link';
import { People } from '../../render/components/people';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { initials } from '../../links/format-when';
import { defineTemplate } from '../define-template';

export type InviteRole = 'ADMIN' | 'MEMBER' | 'GUEST';

/** The product's role names (Figma says "Editor"), spec 4.4 item 6. */
export const ROLE_LABEL: Record<InviteRole, string> = {
  ADMIN: 'Admin',
  MEMBER: 'Member',
  GUEST: 'Viewer',
};

export const ROLE_EMAIL_LINE: Record<InviteRole, string> = {
  ADMIN: 'Admin · manage members, channels and approvals',
  MEMBER: 'Member · create, schedule and publish',
  GUEST: 'Viewer · draft posts and view the workspace',
};

function roleArticle(role: InviteRole): 'an' | 'a' {
  return /^[AEIOU]/.test(ROLE_LABEL[role]) ? 'an' : 'a';
}

/** "an Admin", "a Member", "a Viewer": Figma reads "as an Editor". */
export function roleWithArticle(role: InviteRole): string {
  return `${roleArticle(role)} ${ROLE_LABEL[role]}`;
}

export interface InvitationProps {
  inviterName: string;
  inviterEmail: string;
  workspaceName: string;
  role: InviteRole;
  channels: number;
  members: number;
  /** Carries the invite token: send this mail inline, never through Redis. */
  acceptUrl: string;
  inviteeEmail: string;
  expiresInDays: number;
}

const FIXTURE: InvitationProps = {
  inviterName: 'M Rehman',
  inviterEmail: 'rehman@lumierecafe.pk',
  workspaceName: 'Rehman Workspace',
  role: 'MEMBER',
  channels: 8,
  members: 3,
  acceptUrl: 'https://app.schedura.ai/invite/accept?token=0123456789abcdef',
  inviteeEmail: 'sana@lumierecafe.pk',
  expiresInDays: 7,
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** B1: sent to the invitee, shows who invited them, to what, with which role. */
export const workspaceInvitation = defineTemplate<InvitationProps>({
  id: 'workspace-invitation',
  category: 'team',
  event: null,
  footer: 'plain',
  subject: (p) =>
    `${p.inviterName} invited you to ${p.workspaceName} on Schedura`,
  preheader: (p) =>
    `Join as ${roleWithArticle(p.role)} to plan and publish posts together.`,
  footerReason: (p) =>
    `You get this because ${p.inviterName} invited ${p.inviteeEmail}.`,
  Body: (p) => (
    <>
      <People
        from={{ initials: initials(p.inviterName), name: p.inviterName }}
        to={{ initials: initials(p.workspaceName), name: p.workspaceName }}
      />
      <Heading>{`Join ${p.workspaceName} on Schedura`}</Heading>
      <Paragraph>
        <Strong>{p.inviterName}</Strong>
        {p.inviterEmail ? ` (${p.inviterEmail})` : ''} invited you to{' '}
        <Strong>{p.workspaceName}</Strong> as {roleArticle(p.role)}{' '}
        <Strong>{ROLE_LABEL[p.role]}</Strong>.
      </Paragraph>
      <DetailRows
        rows={[
          { label: 'Role', value: ROLE_EMAIL_LINE[p.role] },
          { label: 'Channels', value: `${p.channels} connected` },
          { label: 'Members', value: plural(p.members, 'person', 'people') },
        ]}
      />
      <EmailButton href={p.acceptUrl} variant="primary">
        Accept invitation
      </EmailButton>
      <FallbackLink href={p.acceptUrl} />
      <Paragraph tone="muted">
        {`This invitation was sent to ${p.inviteeEmail} and expires in ${plural(p.expiresInDays, 'day', 'days')}. Not expecting it? You can ignore this email.`}
      </Paragraph>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    admin: { ...FIXTURE, role: 'ADMIN' },
    viewer: { ...FIXTURE, role: 'GUEST', channels: 0, members: 1 },
  },
});
