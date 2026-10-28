import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import { messageEntryOf } from './timeline-entry';

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
