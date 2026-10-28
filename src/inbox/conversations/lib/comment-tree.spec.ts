import type { CommentActions, UserRef } from '../dto/contract';
import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import { buildCommentTree, commentNodeOf } from './comment-tree';

const FLAG = { allowed: true };
const ACTIONS: CommentActions = {
  reply: FLAG,
  like: FLAG,
  hide: FLAG,
  delete: FLAG,
  privateReply: FLAG,
};
const BASE = Date.parse('2026-03-10T09:00:00.000Z');

function item(
  id: string,
  parent: string | null,
  minute: number,
  over: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: `uuid-${id}`,
    platform: 'facebook',
    platformItemId: id,
    platformParentId: parent,
    authorHandle: `@${id}`,
    authorDisplayName: `Name ${id}`,
    authorAvatarUrl: null,
    text: `text ${id}`,
    status: 'unread',
    fromMe: false,
    isHidden: false,
    repliedAt: null,
    authoredByUserId: null,
    platformCreatedAt: new Date(BASE + minute * 60_000),
    metadata: {},
    ...over,
  } as unknown as InboxItem;
}

const none = new Map<string, UserRef>();
const actionsFor = () => ACTIONS;

describe('buildCommentTree', () => {
  it('nests three levels, oldest first at every level', () => {
    const items = [
      item('c', 'b1', 5),
      item('b2', 'a', 4),
      item('b1', 'a', 2),
      item('a2', null, 3),
      item('a', null, 1),
    ];
    const tree = buildCommentTree(items, none, actionsFor);
    expect(tree.map((n) => n.id)).toEqual(['uuid-a', 'uuid-a2']);
    const a = tree[0];
    expect(a.replies.map((n) => n.id)).toEqual(['uuid-b1', 'uuid-b2']);
    expect(a.replies[0].replies.map((n) => n.id)).toEqual(['uuid-c']);
    expect(a.replies[0].replies[0].parentId).toBe('uuid-b1');
    expect(a.replies[0].parentId).toBe('uuid-a');
    expect(a.parentId).toBeNull();
  });

  it('turns an orphan reply (parent not in the set) into a root', () => {
    const tree = buildCommentTree(
      [item('a', null, 1), item('o', 'gone', 2)],
      none,
      actionsFor,
    );
    expect(tree.map((n) => n.id)).toEqual(['uuid-a', 'uuid-o']);
    expect(tree[1].parentId).toBeNull();
  });

  it('builds 500 items in under 100 ms', () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      item(`n${i}`, i === 0 ? null : `n${Math.floor((i - 1) / 2)}`, 500 - i),
    );
    const t0 = performance.now();
    const tree = buildCommentTree(items, none, actionsFor);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(tree).toHaveLength(1);
  });

  it('survives a parent cycle without looping', () => {
    const tree = buildCommentTree(
      [item('x', 'y', 1), item('y', 'x', 2)],
      none,
      actionsFor,
    );
    expect(Array.isArray(tree)).toBe(true);
  });

  it('resolves sentBy through the users map', () => {
    const user: UserRef = { id: 'u1', name: 'Sam', avatarUrl: null };
    const tree = buildCommentTree(
      [item('a', null, 1, { authoredByUserId: 'u1', fromMe: true })],
      new Map([['u1', user]]),
      actionsFor,
    );
    expect(tree[0].sentBy).toBe(user);
  });
});

describe('commentNodeOf', () => {
  const user: UserRef = { id: 'u1', name: 'Sam', avatarUrl: null };

  it('maps the contract fields', () => {
    const node = commentNodeOf(
      item('a', null, 1, {
        metadata: { likeCount: 4, likedByUs: true, permalink: 'https://x/y' },
        repliedAt: new Date(BASE),
        isHidden: true,
        authoredByUserId: 'u1',
        fromMe: true,
      }),
      user,
      ACTIONS,
    );
    expect(node).toStrictEqual({
      id: 'uuid-a',
      parentId: null,
      author: { handle: '@a', displayName: 'Name a', avatarUrl: null },
      text: 'text a',
      at: new Date(BASE + 60_000).toISOString(),
      fromMe: true,
      sentBy: user,
      unread: false,
      answered: true,
      isHidden: true,
      likeCount: 4,
      likedByUs: true,
      contentRedacted: false,
      permalink: 'https://x/y',
      actions: ACTIONS,
      replies: [],
    });
  });

  it('defaults likeCount/permalink to null and likedByUs to false', () => {
    const node = commentNodeOf(item('a', null, 1), null, ACTIONS);
    expect(node.likeCount).toBeNull();
    expect(node.likedByUs).toBe(false);
    expect(node.permalink).toBeNull();
    expect(node.unread).toBe(true);
    expect(node.answered).toBe(false);
  });

  it('flags a wiped YouTube comment as redacted with empty text', () => {
    const node = commentNodeOf(
      item('a', null, 1, { platform: 'youtube', text: null }),
      null,
      ACTIONS,
    );
    expect(node.contentRedacted).toBe(true);
    expect(node.text).toBe('');
  });
});
