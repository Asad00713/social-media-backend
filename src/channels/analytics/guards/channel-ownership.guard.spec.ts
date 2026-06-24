import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelOwnershipGuard,
  type ChannelLookupRepo,
} from './channel-ownership.guard';

function mockCtx(params: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params }),
    }),
  } as unknown as ExecutionContext;
}

describe('ChannelOwnershipGuard', () => {
  const fakeRepo: jest.Mocked<ChannelLookupRepo> = {
    findChannel: jest.fn(),
  };
  let guard: ChannelOwnershipGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ChannelOwnershipGuard(fakeRepo);
  });

  it('throws NotFoundException when channelId param is not a number', async () => {
    const ctx = mockCtx({ wsId: 'ws-1', channelId: 'not-a-num' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when channel does not exist', async () => {
    fakeRepo.findChannel.mockResolvedValue(null);
    const ctx = mockCtx({ wsId: 'ws-1', channelId: '42' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when channel belongs to different workspace', async () => {
    fakeRepo.findChannel.mockResolvedValue({ id: 42, workspaceId: 'ws-OTHER' });
    const ctx = mockCtx({ wsId: 'ws-1', channelId: '42' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows when channel belongs to requested workspace', async () => {
    fakeRepo.findChannel.mockResolvedValue({ id: 42, workspaceId: 'ws-1' });
    const ctx = mockCtx({ wsId: 'ws-1', channelId: '42' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
