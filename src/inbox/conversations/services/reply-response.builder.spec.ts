import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import { ReplyResponseBuilder } from './reply-response.builder';

const WS = 'ws-1';
const USER = 'u1';
const AT = new Date('2026-10-26T10:00:00.000Z');

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'item-1',
    workspaceId: WS,
    channelId: 7,
    platform: 'facebook',
    type: 'comment',
    platformItemId: 'c-new',
    platformParentId: 'c-parent',
    platformPostId: 'p1',
    conversationId: null,
    threadKey: '7:p1',
    fromMe: true,
    status: 'replied',
    isHidden: false,
    authorHandle: 'brand',
    authorDisplayName: 'Brand',
    authorAvatarUrl: null,
    text: 'thanks!',
    platformCreatedAt: AT,
    repliedAt: null,
    metadata: {},
    ...over,
  } as unknown as InboxItem;
}

function build(opts: { row?: unknown; canDeleteDm?: boolean } = {}) {
  const found = {
    users: { id: USER, name: 'Sam', avatarUrl: null },
    channel: { username: '@brand', accountName: 'Brand' },
    parent: { id: 'parent-node' },
  };
  const db = {
    query: {
      users: { findFirst: jest.fn(() => Promise.resolve(found.users)) },
      socialMediaChannels: {
        findFirst: jest.fn(() => Promise.resolve(found.channel)),
      },
      inboxItems: { findFirst: jest.fn(() => Promise.resolve(found.parent)) },
    },
  };
  const inbox = { loadItemForResponse: jest.fn() };
  const presenter = {
    loadRowByThreadKey: jest.fn(() =>
      Promise.resolve('row' in opts ? opts.row : { id: 'conv-1' }),
    ),
  };
  const dm = opts.canDeleteDm ? { deleteDm: jest.fn() } : {};
  const dispatcher = {
    supportsDm: jest.fn(() => true),
    getDm: jest.fn(() => dm),
  };
  const builder = new ReplyResponseBuilder(
    db as never,
    inbox as never,
    presenter as never,
    dispatcher as never,
  );
  return { builder, inbox, presenter, db };
}

describe('ReplyResponseBuilder', () => {
  it('forComment builds the node for the sender and loads the row by the item thread key', async () => {
    const c = build();
    c.inbox.loadItemForResponse.mockResolvedValue(item());
    const out = await c.builder.forComment(WS, USER, { id: 'item-1' });
    expect(c.inbox.loadItemForResponse).toHaveBeenCalledWith(WS, 'item-1');
    expect(out.node.id).toBe('item-1');
    expect(out.node.parentId).toBe('parent-node');
    expect(out.node.fromMe).toBe(true);
    expect(out.node.sentBy).toEqual({ id: USER, name: 'Sam', avatarUrl: null });
    expect(out.node.actions.reply.allowed).toBe(true);
    // our own comment: no hide, no private reply
    expect(out.node.actions.hide.allowed).toBe(false);
    expect(out.node.actions.privateReply.allowed).toBe(false);
    expect(c.presenter.loadRowByThreadKey).toHaveBeenCalledWith(WS, '7:p1');
    expect(out.row).toEqual({ id: 'conv-1' });
  });

  it('forComment on a top-level comment has no parent node', async () => {
    const c = build();
    c.inbox.loadItemForResponse.mockResolvedValue(
      item({ platformParentId: null }),
    );
    const out = await c.builder.forComment(WS, USER, { id: 'item-1' });
    expect(out.node.parentId).toBeNull();
    expect(c.db.query.inboxItems.findFirst).not.toHaveBeenCalled();
  });

  it('an item with no thread key returns row null instead of failing the send', async () => {
    const c = build();
    c.inbox.loadItemForResponse.mockResolvedValue(item({ threadKey: null }));
    const out = await c.builder.forComment(WS, USER, { id: 'item-1' });
    expect(out.row).toBeNull();
    expect(c.presenter.loadRowByThreadKey).not.toHaveBeenCalled();
  });

  it('forDm builds a message entry from me, with the sender, and the row', async () => {
    const c = build({ canDeleteDm: true });
    c.inbox.loadItemForResponse.mockResolvedValue(
      item({
        type: 'dm',
        platformPostId: null,
        platformParentId: null,
        conversationId: 'conv',
        threadKey: '7:conv',
      }),
    );
    const out = await c.builder.forDm(WS, USER, { id: 'item-1' });
    expect(out.entry).toMatchObject({
      kind: 'message',
      id: 'item-1',
      from: 'me',
      text: 'thanks!',
      sentBy: { id: USER, name: 'Sam' },
      canDelete: true,
    });
    expect(c.presenter.loadRowByThreadKey).toHaveBeenCalledWith(WS, '7:conv');
  });

  it('forDm: canDelete is false when the platform cannot delete a DM', async () => {
    const c = build({ canDeleteDm: false });
    c.inbox.loadItemForResponse.mockResolvedValue(
      item({ type: 'dm', conversationId: 'conv', threadKey: '7:conv' }),
    );
    const out = await c.builder.forDm(WS, USER, { id: 'item-1' });
    expect(out.entry.canDelete).toBe(false);
  });
});
