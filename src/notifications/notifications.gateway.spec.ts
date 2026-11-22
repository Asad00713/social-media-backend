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
  live = true,
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
  const check = { isLive: jest.fn().mockResolvedValue(live) };
  const gateway = new NotificationsGateway(
    jwt,
    config as never,
    db as never,
    check as never,
  );
  return { gateway, jwt, check };
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

/** A session token (every token the issuer mints carries a sid). */
function tokenAt(jwt: JwtService, iat: number): string {
  return jwt.sign(
    {
      sub: 'u1',
      email: 'a@b.co',
      iat,
      sid: '33333333-3333-4333-8333-333333333333',
    },
    { secret: SECRET },
  );
}

/** A pre-deploy (or stray-minted) token with no session row behind it. */
function sidlessTokenAt(jwt: JwtService, iat: number): string {
  return jwt.sign({ sub: 'u1', email: 'a@b.co', iat }, { secret: SECRET });
}

describe('NotificationsGateway.handleConnection session (sid)', () => {
  const SID = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const sidToken = (jwt: JwtService, iat: number) =>
    jwt.sign({ sub: 'u1', email: 'a@b.co', iat, sid: SID }, { secret: SECRET });

  it('disconnects a handshake whose sid is revoked', async () => {
    const { gateway, jwt, check } = setup(
      { sessionsRevokedAt: null },
      undefined,
      false,
    );
    const client = socketWith(sidToken(jwt, 1_800_000_000));
    await gateway.handleConnection(client as never);
    expect(check.isLive).toHaveBeenCalledWith(SID, 'u1');
    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('a live sid connects even when it predates the floor (row is the authority)', async () => {
    const { gateway, jwt } = setup({ sessionsRevokedAt: REVOKED_AT });
    const client = socketWith(sidToken(jwt, 1_699_000_000));
    await gateway.handleConnection(client as never);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalledWith('user:u1');
  });
});

describe('NotificationsGateway.handleConnection session revocation', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a sid-less token issued before sessions_revoked_at', async () => {
    const { gateway, jwt } = setup({ sessionsRevokedAt: REVOKED_AT });
    const client = socketWith(sidlessTokenAt(jwt, 1_699_999_999));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('refuses a sid-less token even with nothing revoked (review ruling 4)', async () => {
    const { gateway, jwt, check } = setup({ sessionsRevokedAt: null });
    const client = socketWith(sidlessTokenAt(jwt, 1_800_000_000));

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(check.isLive).not.toHaveBeenCalled();
  });

  it('accepts a session token issued in the revocation second', async () => {
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

describe('NotificationsGateway.handleConnection token shape', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a super-admin challenge token signed with the access secret', async () => {
    const { gateway, jwt } = setup({ sessionsRevokedAt: null });
    const challenge = jwt.sign(
      { sub: 'u1', email: 'a@b.co', purpose: 'admin-login' },
      { secret: SECRET, expiresIn: '5m' },
    );
    const client = socketWith(challenge);

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });
});
