import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NotificationsGateway } from './notifications.gateway';

const SECRET = 'test-access-secret';
// Revoked at 1_700_000_000.500 s: the cutoff is the whole second 1_700_000_000.
const REVOKED_AT = new Date(1_700_000_000_500);

function setup(
  account:
    | { sessionsRevokedAt: Date | null; deletedAt?: Date | null }
    | undefined,
  lookupError?: Error,
) {
  const jwt = new JwtService({});
  const where = lookupError
    ? jest.fn().mockRejectedValue(lookupError)
    : jest.fn().mockResolvedValue(account ? [account] : []);
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where }),
    }),
  };
  const config = { get: jest.fn().mockReturnValue(SECRET) };
  const gateway = new NotificationsGateway(jwt, config as never, db as never);
  return { gateway, jwt };
}

function socketWith(token: string) {
  return {
    id: 'sock-1',
    handshake: { auth: { token }, query: {} },
    join: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function tokenAt(jwt: JwtService, iat: number): string {
  return jwt.sign({ sub: 'u1', email: 'a@b.co', iat }, { secret: SECRET });
}

describe('NotificationsGateway.handleConnection session revocation', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a token issued before sessions_revoked_at', async () => {
    const { gateway, jwt } = setup({ sessionsRevokedAt: REVOKED_AT });
    const client = socketWith(tokenAt(jwt, 1_699_999_999));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('accepts a token issued in the revocation second', async () => {
    const { gateway, jwt } = setup({ sessionsRevokedAt: REVOKED_AT });
    const client = socketWith(tokenAt(jwt, 1_700_000_000));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalledWith('user:u1');
    expect(client.emit).toHaveBeenCalledWith('connected', {
      userId: 'u1',
      socketId: 'sock-1',
    });
  });

  it('refuses a token whose user no longer exists', async () => {
    const { gateway, jwt } = setup(undefined);
    const client = socketWith(tokenAt(jwt, 1_700_000_000));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('fails closed when the account lookup rejects: disconnects, joins nothing, emits nothing', async () => {
    const { gateway, jwt } = setup(undefined, new Error('connection reset'));
    const client = socketWith(tokenAt(jwt, 1_700_000_000));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted account, whatever the token', async () => {
    const { gateway, jwt } = setup({
      sessionsRevokedAt: null,
      deletedAt: new Date(),
    });
    const client = socketWith(tokenAt(jwt, 1_900_000_000));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });
});

describe('NotificationsGateway.disconnectUser', () => {
  it("drops every socket in the user's room", () => {
    const { gateway } = setup(undefined);
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn().mockReturnValue({ disconnectSockets });
    gateway.server = { in: inRoom } as never;

    gateway.disconnectUser('u1');

    expect(inRoom).toHaveBeenCalledWith('user:u1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });
});
