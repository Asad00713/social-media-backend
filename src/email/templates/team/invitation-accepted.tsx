import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { People } from '../../render/components/people';
import { Heading } from '../../render/components/text';
import { initials } from '../../links/format-when';
import { defineTemplate } from '../define-template';
import {
  ROLE_LABEL,
  roleWithArticle,
  type InviteRole,
} from './workspace-invitation';

export interface InvitationAcceptedProps {
  memberName: string;
  memberEmail: string;
  workspaceName: string;
  role: InviteRole;
  /** The join day, already formatted in the inviter's workspace zone. */
  joined: string;
  membersUrl: string;
}

const ROLE_VERB: Record<InviteRole, string> = {
  ADMIN: 'manage the workspace',
  MEMBER: 'create and schedule posts',
  GUEST: 'draft posts and view the workspace',
};

/** B2: sent to whoever invited the member. Follows Notifications > Member joined. */
export const invitationAccepted = defineTemplate<InvitationAcceptedProps>({
  id: 'invitation-accepted',
  category: 'team',
  event: 'member_activity',
  footer: 'notification',
  subject: (p) => `${p.memberName} joined ${p.workspaceName}`,
  preheader: (p) =>
    `They can now ${ROLE_VERB[p.role]} as ${roleWithArticle(p.role)}.`,
  Body: (p) => (
    <>
      <People
        from={{ initials: initials(p.memberName), name: p.memberName }}
        to={{ initials: initials(p.workspaceName), name: p.workspaceName }}
      />
      <Heading>{`${p.memberName} joined ${p.workspaceName}`}</Heading>
      <DetailRows
        rows={[
          { label: 'Name', value: p.memberName },
          { label: 'Email', value: p.memberEmail },
          { label: 'Role', value: ROLE_LABEL[p.role] },
          { label: 'Joined', value: p.joined },
        ]}
      />
      <EmailButton href={p.membersUrl} variant="secondary">
        Manage members
      </EmailButton>
    </>
  ),
  fixture: {
    memberName: 'Sana Noor',
    memberEmail: 'sana@lumierecafe.pk',
    workspaceName: 'Rehman Workspace',
    role: 'MEMBER',
    joined: 'Oct 26, 2026',
    membersUrl: 'https://app.schedura.ai/w/ws-1/settings/team',
  },
});
