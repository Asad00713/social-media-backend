/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */

/** The channel row the dispatcher's lookup resolves to (set per test). */
let channelRow: Record<string, unknown> | undefined;

jest.mock('../drizzle/db', () => {
  const mkChain = (rows: () => unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows())
          : () => mkChain(rows),
    });
  return {
    db: { select: () => mkChain(() => (channelRow ? [channelRow] : [])) },
  };
});

import { Logger } from '@nestjs/common';
import { NotificationDispatcherService } from './notification-dispatcher.service';

const ROUTE = {
  id: 'route-1',
  workspaceId: 'ws-1',
  channelId: 7,
  targetPlatformChannelId: 'C123',
};

function build() {
  const channels = { getAccessToken: jest.fn().mockResolvedValue('tok') };
  const slack = { postMessage: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationDispatcherService(
    {} as any,
    channels as any,
    slack as any,
    {} as any,
  );
  return { service, channels, slack };
}

describe('NotificationDispatcherService.deliver', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('skips a route whose channel belongs to another workspace and never calls slack.postMessage', async () => {
    channelRow = {
      id: 7,
      workspaceId: 'ws-OTHER',
      platform: 'slack',
      connectionStatus: 'connected',
    };
    const { service, channels, slack } = build();

    await (service as any).deliver(ROUTE, 'boost.failed', {});

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(channels.getAccessToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('route-1'));
  });

  it('still delivers when the channel belongs to the route workspace', async () => {
    channelRow = {
      id: 7,
      workspaceId: 'ws-1',
      platform: 'slack',
      connectionStatus: 'connected',
    };
    const { service, slack } = build();

    await (service as any).deliver(ROUTE, 'boost.failed', {});

    expect(slack.postMessage).toHaveBeenCalledWith('tok', {
      channel: 'C123',
      text: expect.any(String),
    });
  });
});
