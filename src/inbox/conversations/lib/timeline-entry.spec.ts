import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import type { InboxNote } from '../../../drizzle/schema/inbox-notes.schema';
import type { ScheduledInboxMessage } from '../../../drizzle/schema/scheduled-inbox-messages.schema';
import {
  messageEntryOf,
  noteEntryOf,
  scheduledEntryOf,
} from './timeline-entry';

const row = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'i1',
    fromMe: false,
    authorHandle: 'ana',
    authorDisplayName: 'Ana',
    authorAvatarUrl: 'https://a/x.png',
    text: 'hello',
    platformCreatedAt: new Date('2026-10-26T10:00:00.000Z'),
    metadata: {},
    ...over,
  }) as InboxItem;

describe('messageEntryOf', () => {
  it('maps an inbound row to from: them', () => {
    expect(messageEntryOf(row(), null, false)).toEqual({
      kind: 'message',
      id: 'i1',
      from: 'them',
      author: {
        handle: 'ana',
        displayName: 'Ana',
        avatarUrl: 'https://a/x.png',
      },
      text: 'hello',
      at: '2026-10-26T10:00:00.000Z',
      attachments: [],
      sentBy: null,
      canDelete: false,
    });
  });

  it('maps an outbound row to from: me and carries sentBy', () => {
    const by = { id: 'u1', name: 'Sam', avatarUrl: null };
    const e = messageEntryOf(row({ fromMe: true }), by, true);
    expect(e).toMatchObject({ from: 'me', sentBy: by, canDelete: true });
  });

  it('uses text: "" when the text is null', () => {
    expect(messageEntryOf(row({ text: null }), null, false)).toMatchObject({
      text: '',
    });
  });

  it('reads attachments from metadata and fills the optional fields with null', () => {
    const e = messageEntryOf(
      row({
        metadata: {
          attachments: [
            { kind: 'image', url: 'https://a/1.png' },
            {
              kind: 'voice',
              url: 'https://a/2.ogg',
              contentType: 'audio/ogg',
              thumbnailUrl: 'https://a/t.png',
            },
          ],
        },
      }),
      null,
      false,
    );
    expect(e).toMatchObject({
      attachments: [
        {
          kind: 'image',
          url: 'https://a/1.png',
          contentType: null,
          thumbnailUrl: null,
        },
        {
          kind: 'voice',
          url: 'https://a/2.ogg',
          contentType: 'audio/ogg',
          thumbnailUrl: 'https://a/t.png',
        },
      ],
    });
  });
});

const sam = { id: 'u1', name: 'Sam', avatarUrl: null };
const bo = { id: 'u2', name: 'Bo', avatarUrl: 'https://a/bo.png' };

const note = (over: Partial<InboxNote> = {}): InboxNote =>
  ({
    id: 'n1',
    authorUserId: 'u1',
    body: 'call them back',
    mentionedUserIds: ['u2'],
    createdAt: new Date('2026-10-26T11:00:00.000Z'),
    ...over,
  }) as InboxNote;

describe('noteEntryOf', () => {
  it('maps a note and lets its author delete it', () => {
    expect(noteEntryOf(note(), sam, [bo], 'u1')).toEqual({
      kind: 'note',
      id: 'n1',
      author: sam,
      body: 'call them back',
      mentions: [bo],
      at: '2026-10-26T11:00:00.000Z',
      canDelete: true,
    });
  });

  it('does not let another viewer delete it', () => {
    expect(noteEntryOf(note(), sam, [], 'u2')).toMatchObject({
      canDelete: false,
      mentions: [],
    });
  });

  it('never grants delete on an authorless note', () => {
    expect(
      noteEntryOf(note({ authorUserId: null }), sam, [], 'u1'),
    ).toMatchObject({ canDelete: false });
  });
});

const sched = (
  over: Partial<ScheduledInboxMessage> = {},
): ScheduledInboxMessage =>
  ({
    id: 's1',
    text: 'later reply',
    scheduledAt: new Date('2026-10-27T09:00:00.000Z'),
    status: 'pending',
    errorMessage: null,
    parentItemId: 'i1',
    attachments: [],
    ...over,
  }) as ScheduledInboxMessage;

describe('scheduledEntryOf', () => {
  it('maps a pending scheduled reply', () => {
    expect(scheduledEntryOf(sched(), sam)).toEqual({
      kind: 'scheduled',
      id: 's1',
      text: 'later reply',
      attachments: [],
      sendAt: '2026-10-27T09:00:00.000Z',
      by: sam,
      status: 'pending',
      error: null,
      parentItemId: 'i1',
    });
  });

  it('maps a failed one with its error and no author', () => {
    expect(
      scheduledEntryOf(
        sched({ status: 'failed', errorMessage: 'token expired' }),
        null,
      ),
    ).toMatchObject({ status: 'failed', error: 'token expired', by: null });
  });

  it('defaults attachments and parentItemId when absent', () => {
    const e = scheduledEntryOf(
      sched({
        attachments: undefined as never,
        parentItemId: null,
        status: 'sending',
      }),
      null,
    );
    expect(e).toMatchObject({
      attachments: [],
      parentItemId: null,
      status: 'pending',
    });
  });

  it('passes attachments through', () => {
    const a = {
      kind: 'image' as const,
      url: 'https://a/i.png',
      contentType: null,
      thumbnailUrl: null,
    };
    expect(scheduledEntryOf(sched({ attachments: [a] }), null)).toMatchObject({
      attachments: [a],
    });
  });
});
