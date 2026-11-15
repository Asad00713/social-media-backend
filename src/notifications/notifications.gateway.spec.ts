import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NotificationsGateway } from './notifications.gateway';

const SECRET = 'test-access-secret';
// Revoked at 1_700_000_000.500 s: the cutoff is the whole second 1_700_000_000.
const REVOKED_AT = new Date(1_700_000_000_500);

function setup(account: { sessionsRevokedAt: Date | null } | undefined) {
  const jwt = new JwtService({});
  const where = jest.fn().mockResolvedValue(account ? [account] : []);
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
});
