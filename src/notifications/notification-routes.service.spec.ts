/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- test doubles are loosely typed */
import { ForbiddenException } from '@nestjs/common';

/** Every db write the service attempts, so a refusal can be shown to write nothing. */
const writes: string[] = [];
/** Rows each successive select resolves to (set per test). */
let selectQueue: unknown[][] = [];
/** How many selects ran. */
let selectCount = 0;

jest.mock('../drizzle/db', () => {
  const mkChain = (rows: () => unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows())
          : () => mkChain(rows),
    });
  return {
    db: {
      select: () => {
        selectCount += 1;
        const rows = selectQueue.shift() ?? [];
        return mkChain(() => rows);
      },
      insert: () => {
        writes.push('insert');
        return mkChain(() => [{ id: 'new' }]);
      },
      update: () => {
        writes.push('update');
        return mkChain(() => [{ id: 'r1', enabled: false }]);
      },
    },
  };
});

import { NotificationRoutesService } from './notification-routes.service';

const WS = 'ws-1';
const ROUTE = { id: 'r1', workspaceId: WS, channelId: 7 };

describe('NotificationRoutesService channel ownership', () => {
  let service: NotificationRoutesService;

  beforeEach(() => {
    writes.length = 0;
    selectQueue = [];
    selectCount = 0;
    service = new NotificationRoutesService();
  });

  it('update() with a channelId of another workspace throws ForbiddenException and writes nothing', async () => {
    // 1st select: the route, 2nd: the channel lookup scoped to the workspace (no row).
    selectQueue = [[ROUTE], []];

    await expect(service.update(WS, 'r1', { channelId: 99 })).rejects.toThrow(
      new ForbiddenException('Channel does not belong to this workspace'),
    );
    expect(writes).toEqual([]);
  });

  it('update() with a channelId of this workspace but disconnected throws ForbiddenException', async () => {
    // The lookup filters disconnected channels out, so it finds no row.
    selectQueue = [[ROUTE], []];

    await expect(service.update(WS, 'r1', { channelId: 8 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(writes).toEqual([]);
  });

  it('update() with a live channel of this workspace updates the row', async () => {
    selectQueue = [[ROUTE], [{ id: 8 }]];

    await service.update(WS, 'r1', { channelId: 8 });

    expect(writes).toEqual(['update']);
  });

  it('update() with only { enabled: false } does not look the channel up and updates the row', async () => {
    selectQueue = [[ROUTE]];

    const row = await service.update(WS, 'r1', { enabled: false });

    expect(selectCount).toBe(1); // the route lookup only
    expect(writes).toEqual(['update']);
    expect(row).toEqual({ id: 'r1', enabled: false });
  });

  it('create() still refuses a foreign channel', async () => {
    selectQueue = [[]];

    await expect(
      service.create(WS, {
        eventType: 'boost.failed',
        channelId: 99,
        targetPlatformChannelId: 'C1',
      } as any),
    ).rejects.toThrow(
      new ForbiddenException('Channel does not belong to this workspace'),
    );
    expect(writes).toEqual([]);
  });
});
