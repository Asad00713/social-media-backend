const owners: Array<{ ownerId: string }> = [];

jest.mock('../../drizzle/db', () => ({
  db: {
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve(owners) }),
      }),
    }),
  },
}));

import { ChannelLockSweepService } from './channel-lock-sweep.service';
import type { AccountChannelsService } from './account-channels.service';

function make(release: (ownerId: string) => Promise<number[]>) {
  const accountChannels = { releaseFreedSlots: jest.fn(release) };
  const svc = new ChannelLockSweepService(
    accountChannels as unknown as AccountChannelsService,
  );
  return { svc, accountChannels };
}

beforeEach(() => {
  owners.length = 0;
});

describe('ChannelLockSweepService', () => {
  it('releases account by account and counts what came back', async () => {
    owners.push({ ownerId: 'a' }, { ownerId: 'b' });
    const { svc, accountChannels } = make((id) =>
      Promise.resolve(id === 'a' ? [98] : []),
    );

    await expect(svc.sweep()).resolves.toBe(1);
    expect(accountChannels.releaseFreedSlots).toHaveBeenCalledWith('a');
    expect(accountChannels.releaseFreedSlots).toHaveBeenCalledWith('b');
  });

  it('one account failing does not stop the others', async () => {
    owners.push({ ownerId: 'broken' }, { ownerId: 'ok' });
    const { svc, accountChannels } = make((id) =>
      id === 'broken'
        ? Promise.reject(new Error('db down'))
        : Promise.resolve([7, 8]),
    );

    await expect(svc.sweep()).resolves.toBe(2);
    expect(accountChannels.releaseFreedSlots).toHaveBeenCalledTimes(2);
  });

  it('does nothing at boot under test', () => {
    owners.push({ ownerId: 'a' });
    const { svc, accountChannels } = make(() => Promise.resolve([1]));
    svc.onApplicationBootstrap();
    expect(accountChannels.releaseFreedSlots).not.toHaveBeenCalled();
  });
});
