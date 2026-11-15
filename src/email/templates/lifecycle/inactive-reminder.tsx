import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface InactiveReminderProps {
  workspaceName: string;
  channels: number;
  drafts: number;
  scheduledThisWeek: number;
  openUrl: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** F2: a status summary of what is waiting, not a guilt trip. */
export const inactiveReminder = defineTemplate<InactiveReminderProps>({
  id: 'inactive-reminder',
  category: 'lifecycle',
  // The account-level preference. EmailFooterService adds the "Stop these
  // reminders" link for this event, and the outbox adds List-Unsubscribe.
  event: 'inactivity_reminder',
  footer: 'plain',
  subject: () => 'Your channels are still connected',
  preheader: (p) =>
    p.channels === 0 && p.drafts === 0
      ? `Pick up where you left off in ${p.workspaceName}.`
      : `${plural(p.channels, 'channel', 'channels')} and ${plural(p.drafts, 'draft', 'drafts')} are waiting in ${p.workspaceName}.`,
  footerReason: () => "You get this because you haven't signed in for 15 days.",
  Body: (p) => (
    <>
      <Heading>Your workspace is ready when you are</Heading>
      <Paragraph>
        {`It's been two weeks since you signed in. Here's what's waiting in ${p.workspaceName}:`}
      </Paragraph>
      <DetailRows
        rows={[
          { label: 'Channels', value: `${p.channels} connected` },
          { label: 'Drafts', value: String(p.drafts) },
          {
            label: 'Scheduled',
            value:
              p.scheduledThisWeek === 0
                ? 'Nothing this week'
                : `${p.scheduledThisWeek} this week`,
          },
        ]}
      />
      <EmailButton href={p.openUrl} variant="primary">
        Open Schedura
      </EmailButton>
    </>
  ),
  fixture: {
    workspaceName: 'Rehman Workspace',
    channels: 8,
    drafts: 3,
    scheduledThisWeek: 0,
    openUrl: 'https://app.schedura.ai/',
  },
  variants: {
    scheduled: {
      workspaceName: 'Rehman Workspace',
      channels: 1,
      drafts: 1,
      scheduledThisWeek: 4,
      openUrl: 'https://app.schedura.ai/',
    },
    empty: {
      workspaceName: 'Rehman Workspace',
      channels: 0,
      drafts: 0,
      scheduledThisWeek: 0,
      openUrl: 'https://app.schedura.ai/',
    },
  },
});
