import { presentRow, type ConversationRecord } from './present-row';

const NOW = new Date('2026-10-26T12:00:00.000Z');

function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'c1',
    kind: 'dm',
    threadKey: '1:abc',
    channelId: 1,
    platform: 'instagram',
    status: 'to_reply',
    title: null,
    participantName: 'Sam',
    participantHandle: 'sam',
    participantAvatarUrl: 'https://a/sam.png',
    thumbnailUrl: 'https://a/post.png',
    lastAuthorLabel: 'Sam',
    lastSnippet: 'hi',
    lastFromMe: false,
    unreadCount: 2,
    lastMessageAt: new Date('2026-10-26T11:00:00.000Z'),
    assignedAt: null,
    laterUntil: null,
    laterUntilReply: false,
    doneAt: null,
    doneVia: null,
    replyWindowClosesAt: null,
    channelUsername: '@daybreak.coffee',
    channelAccountName: 'Daybreak Coffee',
    assignee: null,
    assignedBy: null,
    doneBy: null,
    scheduled: null,
    ...over,
  };
}

describe('presentRow', () => {
  it('strips the leading @ from the channel username', () => {
    expect(presentRow(rec(), NOW).channelLabel).toBe('daybreak.coffee');
  });

  it('falls back to the account name without a username', () => {
    expect(presentRow(rec({ channelUsername: null }), NOW).channelLabel).toBe(
      'Daybreak Coffee',
    );
  });

  it('a dm has the avatar and no thumbnail', () => {
    const row = presentRow(rec(), NOW);
    expect(row.avatarUrl).toBe('https://a/sam.png');
    expect(row.thumbnailUrl).toBeNull();
    expect(row.title).toBe('Sam');
  });

  it('a comment_thread has the thumbnail and no avatar', () => {
    const row = presentRow(rec({ kind: 'comment_thread', title: 'Post' }), NOW);
    expect(row.avatarUrl).toBeNull();
    expect(row.thumbnailUrl).toBe('https://a/post.png');
    expect(row.title).toBe('Post');
  });

  it('flags a wiped YouTube snippet as redacted, not an Instagram one', () => {
    expect(
      presentRow(rec({ platform: 'youtube', lastSnippet: null }), NOW)
        .contentRedacted,
    ).toBe(true);
    expect(
      presentRow(rec({ platform: 'instagram', lastSnippet: null }), NOW)
        .contentRedacted,
    ).toBe(false);
    expect(
      presentRow(rec({ platform: 'youtube', lastSnippet: '' }), NOW)
        .contentRedacted,
    ).toBe(false);
  });

  it('computes the reply window state at the injected now', () => {
    const closes = new Date('2026-10-26T12:30:00.000Z');
    const r = rec({ replyWindowClosesAt: closes });
    expect(presentRow(r, NOW).replyWindow).toEqual({
      closesAt: closes.toISOString(),
      state: 'closing',
    });
    expect(
      presentRow(r, new Date('2026-10-26T10:00:00.000Z')).replyWindow.state,
    ).toBe('open');
    expect(
      presentRow(r, new Date('2026-10-26T13:00:00.000Z')).replyWindow.state,
    ).toBe('closed');
    expect(presentRow(rec(), NOW).replyWindow).toEqual({
      closesAt: null,
      state: 'none',
    });
  });

  it('serialises dates and the snippet', () => {
    const row = presentRow(
      rec({ lastSnippet: null, lastFromMe: true, lastAuthorLabel: null }),
      NOW,
    );
    expect(row.lastMessageAt).toBe('2026-10-26T11:00:00.000Z');
    expect(row.snippet).toEqual({
      authorLabel: null,
      text: '',
      fromMe: true,
    });
  });
});
