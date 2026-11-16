import type { PreferenceEventKey } from '../../../notification-preferences/notification-events';
import { EmailButton } from '../../render/components/button';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export type InboxActivityKind = 'assigned' | 'mention' | 'new_message';

export interface InboxActivityProps {
  kind: InboxActivityKind;
  /** The whole event in one line: `Hina assigned you a conversation`. */
  sentence: string;
  workspaceName: string;
  conversationUrl: string;
}

/** The preference event each kind answers to (spec 4.2). */
export const INBOX_EVENT: Record<InboxActivityKind, PreferenceEventKey> = {
  assigned: 'inbox_assigned',
  mention: 'inbox_mention',
  new_message: 'inbox_new_message',
};

const FIXTURE: InboxActivityProps = {
  kind: 'assigned',
  sentence: 'Hina assigned you a conversation',
  workspaceName: 'Rehman Workspace',
  conversationUrl: 'http://localhost:3001/w/demo/inbox?c=demo',
};

/** Someone assigned, mentioned or messaged you in the Inbox. */
export const inboxActivity = defineTemplate<InboxActivityProps>({
  id: 'inbox-activity',
  category: 'inbox',
  // The default; `eventFor` picks the real one from `kind`.
  event: INBOX_EVENT.new_message,
  eventFor: (p) => INBOX_EVENT[p.kind],
  footer: 'notification',
  subject: (p) => p.sentence,
  preheader: (p) => `In ${p.workspaceName}. Open it to reply.`,
  Body: (p) => (
    <>
      <Heading>{p.sentence}</Heading>
      <Paragraph>{`This is in the Inbox of ${p.workspaceName}.`}</Paragraph>
      <EmailButton href={p.conversationUrl} variant="primary">
        Open conversation
      </EmailButton>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    mention: {
      ...FIXTURE,
      kind: 'mention',
      sentence: 'Hina mentioned you in a note',
    },
    newMessage: {
      ...FIXTURE,
      kind: 'new_message',
      sentence: 'New message from Sam',
    },
    unsafe: {
      ...FIXTURE,
      kind: 'new_message',
      sentence: `New message from <script>alert("x")</script> & ${'Sam '.repeat(60)}`,
      workspaceName: 'A & B "Studio" <b>',
    },
  },
});
