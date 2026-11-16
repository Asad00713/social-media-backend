import { eq } from 'drizzle-orm';
import { workspaceInvitation } from '../../../drizzle/schema';
import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface RemovedProps {
  workspaceName: string;
  removedByName: string;
  /** The removal day, already formatted in the member's zone. */
  removedOn: string;
  openUrl: string;
  /** The membership row and the removal instant (ms), for `stillApplies`. */
  membershipId: string;
  removedAtMs: number;
}

/**
 * B3: plain and calm, says what happens to their work. Sent to the removed
 * member once the undo window has passed, and only while the row is still
 * REMOVED by this same removal: an undo, or an undo then a fresh removal
 * (which queues its own B3), drops it.
 */
export const removedFromWorkspace = defineTemplate<RemovedProps>({
  id: 'removed-from-workspace',
  category: 'team',
  event: null,
  footer: 'plain',
  subject: (p) => `You no longer have access to ${p.workspaceName}`,
  preheader: () => 'Posts you created stay in the workspace.',
  footerReason: () =>
    'You get this because your access to a workspace changed.',
  stillApplies: async (p, { db }) => {
    const row = await db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.id, p.membershipId),
      columns: { status: true, removedAt: true },
    });
    return (
      row?.status === 'REMOVED' && row.removedAt?.getTime() === p.removedAtMs
    );
  },
  Body: (p) => (
    <>
      <Heading>{`You no longer have access to ${p.workspaceName}`}</Heading>
      <Paragraph>
        {`${p.removedByName} removed you from ${p.workspaceName} on ${p.removedOn}. Posts and drafts you created stay in the workspace.`}
      </Paragraph>
      <Callout tone="info">
        Your Schedura account is still active. You can create your own workspace
        or join another one.
      </Callout>
      <EmailButton href={p.openUrl} variant="secondary">
        Open Schedura
      </EmailButton>
    </>
  ),
  fixture: {
    workspaceName: 'Rehman Workspace',
    removedByName: 'M Rehman',
    removedOn: 'Oct 26, 2026',
    openUrl: 'https://app.schedura.ai/',
    membershipId: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b',
    removedAtMs: Date.UTC(2026, 9, 26, 10, 30),
  },
});
