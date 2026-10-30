import { deriveThreadKey, kindOfItem } from './thread-key';

const base = {
  channelId: 12,
  type: 'comment',
  platformPostId: null,
  conversationId: null,
  platformItemId: 'x1',
};

const rows = [
  {
    name: 'dm',
    row: {
      ...base,
      type: 'dm',
      conversationId: 'pg:9',
      platformPostId: 'p-ignored',
    },
    key: '12:pg:9',
    kind: 'dm',
  },
  {
    name: 'comment on a post',
    row: { ...base, platformPostId: 'p1' },
    key: '12:p1',
    kind: 'comment_thread',
  },
  {
    name: 'mention',
    row: { ...base, type: 'mention', platformItemId: 'm7' },
    key: '12:mention:m7',
    kind: 'mention',
  },
  {
    name: 'our reply to a mention',
    row: {
      ...base,
      type: 'mention',
      platformItemId: 'r1',
      metadata: { mentionRoot: 'm7' },
    },
    key: '12:mention:m7',
    kind: 'mention',
  },
  {
    name: 'comment-typed row without a post id',
    row: { ...base, platformItemId: 'c5' },
    key: '12:mention:c5',
    kind: 'mention',
  },
  {
    name: 'dm without a conversation id',
    row: { ...base, type: 'dm' },
    key: null,
    kind: 'dm',
  },
] as const;

describe('thread key', () => {
  it.each(rows)('deriveThreadKey: $name', ({ row, key }) => {
    expect(deriveThreadKey(row)).toBe(key);
  });
  it.each(rows)('kindOfItem: $name', ({ row, kind }) => {
    expect(kindOfItem(row)).toBe(kind);
  });
});
