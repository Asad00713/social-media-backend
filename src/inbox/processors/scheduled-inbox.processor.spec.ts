import { UnrecoverableError, type Job } from 'bullmq';
import type { ScheduledInboxMessage } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import type { WorkspaceRole } from '../../workspace-members/role-capabilities';
import type { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import type { InboxService } from '../inbox.service';
import type { ScheduledMessagesService } from '../services/scheduled-messages.service';
import {
  ScheduledInboxProcessor,
  type ScheduledInboxFireJob,
} from './scheduled-inbox.processor';

const WS = '11111111-1111-4111-8111-111111111111';
const fake = <T>(impl: Record<string, unknown>): T => impl as unknown as T;

function row(over: Partial<ScheduledInboxMessage> = {}): ScheduledInboxMessage {
  return {
    id: 's1',
    workspaceId: WS,
    channelId: 4,
    type: 'dm',
    threadKey: '4:pg:9',
    text: 'hi',
    createdByUserId: 'u1',
    parentItemId: null,
    attachments: [],
    ...over,
  } as ScheduledInboxMessage;
}

function setup(role: WorkspaceRole | null, claimed = row()) {
  const scheduled = {
    claimForFire: jest.fn().mockResolvedValue(claimed),
    markSent: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    resetToPendingForRetry: jest.fn().mockResolvedValue(undefined),
  };
  const inbox = {
    sendDm: jest.fn().mockResolvedValue({ id: 'item-1' }),
    reply: jest.fn().mockResolvedValue({ id: 'item-2' }),
    commentOnPost: jest.fn().mockResolvedValue({ id: 'item-3' }),
  };
  const roles = { getRole: jest.fn().mockResolvedValue(role) };
  const processor = new ScheduledInboxProcessor(
    fake<ScheduledMessagesService>(scheduled),
    fake<InboxService>(inbox),
    fake<WorkspaceRoleService>(roles),
  );
  const job = fake<Job<ScheduledInboxFireJob>>({
    id: 'j1',
    name: 'fire',
    data: { scheduledId: 's1' },
    attemptsMade: 0,
    timestamp: Date.now(),
    opts: { attempts: 3 },
  });
  return { processor, scheduled, inbox, roles, job };
}

describe('ScheduledInboxProcessor capability at fire', () => {
  it('fails a reply whose creator was demoted to GUEST, without retry and without sending', async () => {
    const { processor, scheduled, inbox, roles, job } = setup('GUEST');

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(roles.getRole).toHaveBeenCalledWith(WS, 'u1');
    expect(scheduled.markFailed).toHaveBeenCalledWith(
      's1',
      'The person who scheduled this can no longer reply in this workspace',
    );
    expect(scheduled.resetToPendingForRetry).not.toHaveBeenCalled();
    expect(inbox.sendDm).not.toHaveBeenCalled();
    expect(inbox.reply).not.toHaveBeenCalled();
    expect(inbox.commentOnPost).not.toHaveBeenCalled();
  });

  it('fails a reply whose creator left the workspace', async () => {
    const { processor, scheduled, inbox, job } = setup(null);

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(scheduled.markFailed).toHaveBeenCalledTimes(1);
    expect(inbox.sendDm).not.toHaveBeenCalled();
  });

  it('sends for a MEMBER, with voice mapped to audio', async () => {
    const claimed = row({
      attachments: [
        {
          kind: 'voice',
          url: 'https://cdn.example.test/v.ogg',
          contentType: 'audio/ogg',
          thumbnailUrl: null,
        },
        {
          kind: 'image',
          url: 'https://cdn.example.test/a.png',
          contentType: null,
          thumbnailUrl: null,
        },
      ],
    });
    const { processor, scheduled, inbox, job } = setup('MEMBER', claimed);

    await processor.process(job);

    expect(inbox.sendDm).toHaveBeenCalledWith(WS, 'u1', '4:pg:9', 'hi', [
      {
        kind: 'audio',
        url: 'https://cdn.example.test/v.ogg',
        contentType: 'audio/ogg',
      },
      {
        kind: 'image',
        url: 'https://cdn.example.test/a.png',
        contentType: 'application/octet-stream',
      },
    ]);
    expect(scheduled.markSent).toHaveBeenCalledWith('s1', 'item-1');
    expect(scheduled.markFailed).not.toHaveBeenCalled();
  });

  it('still retries an ordinary send error', async () => {
    const { processor, scheduled, inbox, job } = setup('ADMIN');
    inbox.sendDm.mockRejectedValue(new Error('network'));

    await expect(processor.process(job)).rejects.toThrow('network');
    expect(scheduled.resetToPendingForRetry).toHaveBeenCalledWith(
      's1',
      'network',
    );
    expect(scheduled.markFailed).not.toHaveBeenCalled();
  });
});
