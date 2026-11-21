import { Logger } from '@nestjs/common';
import { AnalyticsEventsGateway } from './analytics-events.gateway';

/** What the fake SessionCheck answers for a sid. */
let sessionLive = true;

const findUser = jest.fn();
jest.mock('../drizzle/db', () => ({
  db: {
    query: {
      users: {
        findFirst: (...a: unknown[]): unknown => findUser(...a) as unknown,
      },
    },
  },
}));

type ConnectingSocket = Parameters<
  AnalyticsEventsGateway['handleConnection']
>[0];

/** `iat` is whole seconds; the revocation is 10 s after the token was issued. */
const ISSUED_AT = 1_900_000_000;

function build(payload: Record<string, unknown>) {
  const verifyAsync = jest.fn().mockResolvedValue(payload);
  const gateway = new AnalyticsEventsGateway(
    { verifyAsync } as never,
    { get: () => 'secret' } as never,
    { getRole: jest.fn() } as never,
    { isLive: jest.fn().mockResolvedValue(sessionLive) } as never,
  );
  const disconnect = jest.fn();
  const fake = {
    id: 's1',
    userId: undefined as string | undefined,
    handshake: { auth: { token: 'tok' }, query: {}, headers: {} },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect,
  };
  return {
    gateway,
    socket: fake as unknown as ConnectingSocket,
    fake,
    disconnect,
  };
}

describe('AnalyticsEventsGateway.handleConnection', () => {
  beforeEach(() => {
    findUser.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('disconnects a token issued before the sessions were revoked', async () => {
    findUser.mockResolvedValue({
      sessionsRevokedAt: new Date((ISSUED_AT + 10) * 1000),
    });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
    expect(fake.userId).toBeUndefined();
  });

  it('accepts a token issued after the revocation', async () => {
    findUser.mockResolvedValue({
      sessionsRevokedAt: new Date((ISSUED_AT - 10) * 1000),
    });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).not.toHaveBeenCalled();
    expect(fake.userId).toBe('u1');
  });

  it('accepts a token when the sessions were never revoked', async () => {
    findUser.mockResolvedValue({ sessionsRevokedAt: null });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).not.toHaveBeenCalled();
    expect(fake.userId).toBe('u1');
  });

  it('disconnects a soft-deleted account (row kept, deleted_at set)', async () => {
    findUser.mockResolvedValue({
      sessionsRevokedAt: null,
      deletedAt: new Date(),
    });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
    expect(fake.userId).toBeUndefined();
  });

  it('disconnects a token for a deleted account', async () => {
    findUser.mockResolvedValue(undefined);
    const { gateway, socket, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
  });
});

describe('AnalyticsEventsGateway.handleConnection token shape', () => {
  beforeEach(() => {
    findUser.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('disconnects a super-admin challenge token (purpose claim)', async () => {
    findUser.mockResolvedValue({ sessionsRevokedAt: null });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      email: 'a@b.co',
      purpose: 'admin-login',
      iat: ISSUED_AT,
    });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
    expect(fake.userId).toBeUndefined();
  });
});

describe('AnalyticsEventsGateway.handleConnection session (sid)', () => {
  const SID = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    findUser.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    sessionLive = true;
    jest.restoreAllMocks();
  });

  it('disconnects a handshake whose sid is revoked', async () => {
    sessionLive = false;
    findUser.mockResolvedValue({ sessionsRevokedAt: null });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
      sid: SID,
    });
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
    expect(fake.join).not.toHaveBeenCalled();
  });

  it('a live sid connects even when it predates the floor', async () => {
    findUser.mockResolvedValue({
      sessionsRevokedAt: new Date((ISSUED_AT + 10) * 1000),
    });
    const { gateway, socket, fake, disconnect } = build({
      sub: 'u1',
      iat: ISSUED_AT,
      sid: SID,
    });
    await gateway.handleConnection(socket);
    expect(disconnect).not.toHaveBeenCalled();
    expect(fake.join).toHaveBeenCalled();
  });
});
