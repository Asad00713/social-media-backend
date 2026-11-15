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
}

/** B3: plain and calm, says what happens to their work. Sent to the removed member. */
export const removedFromWorkspace = defineTemplate<RemovedProps>({
  id: 'removed-from-workspace',
  category: 'team',
  event: null,
  footer: 'plain',
  subject: (p) => `You no longer have access to ${p.workspaceName}`,
  preheader: () => 'Posts you created stay in the workspace.',
  footerReason: () =>
    'You get this because your access to a workspace changed.',
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
  },
});
