import { BadRequestException, NotFoundException } from '@nestjs/common';

// InboxService imports `db` as a module-level singleton (not DI-injected),
// so a real Nest TestingModule can't intercept it — jest.mock the module and
// drive the specific query paths `hideComment` touches: workspace ownership
// check, inbox item lookup, channel lookup (inside resolveChannel), update.
jest.mock('../drizzle/db', () => ({
  db: {
    query: {
      workspace: { findFirst: jest.fn() },
      workspaceInvitation: { findFirst: jest.fn() },
      inboxItems: { findFirst: jest.fn() },
      socialMediaChannels: { findFirst: jest.fn() },
    },
    update: jest.fn(),
  },
}));

import { db } from '../drizzle/db';
import { InboxService } from './inbox.service';

describe('InboxService.hideComment', () => {
  let service: InboxService;
  let emitter: { emit: jest.Mock };
  let dispatcher: { get: jest.Mock };
  let channelService: { getAccessToken: jest.Mock };
  let setMock: jest.Mock;
  let whereMock: jest.Mock;

  const workspaceId = 'ws-1';
  const userId = 'user-1';
  const itemId = 'item-1';

  const inboxRow = {
    id: itemId,
    workspaceId,
    channelId: 42,
    platform: 'threads',
    platformItemId: 'reply-99',
    isHidden: false,
    metadata: {},
  };

  const channelRow = {
    id: 42,
    workspaceId,
    platform: 'threads',
    platformAccountId: 'acc-42',
    metadata: {},
    username: 'schedura',
    accountName: 'Schedura',
    profilePictureUrl: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    emitter = { emit: jest.fn() };
    dispatcher = { get: jest.fn() };
    channelService = { getAccessToken: jest.fn().mockResolvedValue('tok') };

    // db.query.workspace.findFirst resolving truthy = caller is the workspace
    // owner, so assertWorkspaceAccess returns early without hitting the
    // workspaceInvitation branch.
    (db.query.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: workspaceId,
    });
    (db.query.inboxItems.findFirst as jest.Mock).mockResolvedValue(inboxRow);
    (db.query.socialMediaChannels.findFirst as jest.Mock).mockResolvedValue(
      channelRow,
    );

    whereMock = jest.fn().mockResolvedValue(undefined);
    setMock = jest.fn().mockReturnValue({ where: whereMock });
    (db.update as jest.Mock).mockReturnValue({ set: setMock });

    service = new InboxService(
      emitter as any,
      dispatcher as any,
      channelService as any,
      {} as any, // FacebookService — unused on this path
      {} as any, // InstagramService — unused on this path
      {} as any, // BullMQ pollQueue — unused on this path
    );

    // emitCounts is a fire-and-forget side effect unrelated to hideComment's
    // own contract; stub it out so the test only exercises the hide path.
    jest.spyOn(service as any, 'emitCounts').mockResolvedValue(undefined);
  });

  it('hides a reply: calls adapter.hideComment, persists isHidden, emits update', async () => {
    const hideComment = jest.fn().mockResolvedValue(undefined);
    dispatcher.get.mockReturnValue({ hideComment });

    const result = await service.hideComment(
      workspaceId,
      userId,
      itemId,
      true,
    );

    expect(result).toEqual({ success: true, isHidden: true });
    expect(hideComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, platform: 'threads' }),
      'reply-99',
      true,
    );
    expect(db.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isHidden: true }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      workspaceId,
      'inbox.item.updated',
      expect.objectContaining({
        id: itemId,
        channelId: 42,
        changes: { isHidden: true },
      }),
    );
  });

  it('unhides a reply when hidden=false', async () => {
    const hideComment = jest.fn().mockResolvedValue(undefined);
    dispatcher.get.mockReturnValue({ hideComment });

    const result = await service.hideComment(
      workspaceId,
      userId,
      itemId,
      false,
    );

    expect(result).toEqual({ success: true, isHidden: false });
    expect(hideComment).toHaveBeenCalledWith(
      expect.anything(),
      'reply-99',
      false,
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isHidden: false }),
    );
  });

  it('throws BadRequestException when the platform adapter has no hideComment', async () => {
    dispatcher.get.mockReturnValue({}); // no hideComment method

    await expect(
      service.hideComment(workspaceId, userId, itemId, true),
    ).rejects.toThrow(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the inbox item does not exist', async () => {
    (db.query.inboxItems.findFirst as jest.Mock).mockResolvedValue(undefined);

    await expect(
      service.hideComment(workspaceId, userId, itemId, true),
    ).rejects.toThrow(NotFoundException);
  });

  it('wraps a platform failure as BadRequestException and does not persist', async () => {
    const hideComment = jest
      .fn()
      .mockRejectedValue(new Error('Meta API 500'));
    dispatcher.get.mockReturnValue({ hideComment });

    await expect(
      service.hideComment(workspaceId, userId, itemId, true),
    ).rejects.toThrow(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });
});
