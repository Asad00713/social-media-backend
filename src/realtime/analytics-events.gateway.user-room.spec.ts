import { Logger } from '@nestjs/common';
import { AnalyticsEventsGateway } from './analytics-events.gateway';

/** What the fake SessionCheck answers for a sid. */
const sessionLive = true;

// The session check at connect finds a user whose sessions were never revoked.
jest.mock('../drizzle/db', () => ({
  db: {
    query: {
      users: {
        findFirst: () => Promise.resolve({ sessionsRevokedAt: null }),
      },
    },
  },
}));

type ConnSocket = Parameters<AnalyticsEventsGateway['handleConnection']>[0];

function build(verify: () => Promise<unknown>) {
  const gateway = new AnalyticsEventsGateway(
    { verifyAsync: jest.fn(verify) } as never,
    { get: () => 'secret' } as never,
    {} as never,
    { isLive: jest.fn().mockResolvedValue(sessionLive) } as never,
  );
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  gateway.server = { to } as never;
  const socket = {
    id: 's1',
    handshake: { auth: { token: 'jwt' }, headers: {}, query: {} },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  };
  return { gateway, socket, emit, to };
}

describe('AnalyticsEventsGateway user room', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('joins the room of the user the TOKEN names', async () => {
    const { gateway, socket } = build(() => Promise.resolve({ sub: 'u1' }));

    await gateway.handleConnection(socket as unknown as ConnSocket);

    expect(socket.join).toHaveBeenCalledWith('user:u1');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('joins nothing when the token does not verify', async () => {
    const { gateway, socket } = build(() => Promise.reject(new Error('bad')));

    await gateway.handleConnection(socket as unknown as ConnSocket);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('emitToUser reaches that user room only', () => {
    const { gateway, to, emit } = build(() => Promise.resolve({ sub: 'u1' }));
    const payload = {
      state: 'recovered' as const,
      provider: 'stripe' as const,
      workspaceId: 'ws',
      card: null,
      occurredAt: '2026-11-15T00:00:00.000Z',
    };

    gateway.emitToUser('u1', 'billing.payment.changed', payload);

    expect(to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('billing.payment.changed', payload);
  });
});
