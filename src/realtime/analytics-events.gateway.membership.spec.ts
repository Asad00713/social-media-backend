import { Logger } from '@nestjs/common';
import { AnalyticsEventsGateway } from './analytics-events.gateway';

// The gateway reads the role through WorkspaceRoleService, never the DB
// directly, so the pool is only stubbed to keep the import side-effect free.
jest.mock('../drizzle/db', () => ({ db: { query: {} } }));

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';

type SubSocket = Parameters<AnalyticsEventsGateway['onSubscribeWorkspace']>[0];

function build(role: string | null = 'MEMBER') {
  const getRole = jest.fn().mockResolvedValue(role);
  const gateway = new AnalyticsEventsGateway(
    {} as never,
    {} as never,
    { getRole } as never,
    {} as never,
  );
  const socketsLeave = jest.fn();
  const inRoom = jest.fn(() => ({ socketsLeave }));
  gateway.server = { in: inRoom } as never;
  const socket = {
    id: 's1',
    userId: 'u1',
    join: jest.fn().mockResolvedValue(undefined),
  };
  return {
    gateway,
    socket,
    asSocket: socket as unknown as SubSocket,
    getRole,
    inRoom,
    socketsLeave,
  };
}

describe('AnalyticsEventsGateway membership', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it("removeUserFromWorkspace makes the user's sockets leave workspace:<id> only", () => {
    const { gateway, inRoom, socketsLeave } = build();

    gateway.removeUserFromWorkspace('u1', WS);

    // The user's own room selects the sockets; only the workspace room is left.
    expect(inRoom).toHaveBeenCalledTimes(1);
    expect(inRoom).toHaveBeenCalledWith('user:u1');
    expect(socketsLeave).toHaveBeenCalledTimes(1);
    expect(socketsLeave).toHaveBeenCalledWith(`workspace:${WS}`);
  });

  it('removeUserFromWorkspace is a no-op before the server exists', () => {
    const { gateway } = build();
    gateway.server = undefined as never;

    expect(() => gateway.removeUserFromWorkspace('u1', WS)).not.toThrow();
  });

  it('subscribe:workspace joins the room when getRole names a role', async () => {
    const { gateway, socket, asSocket, getRole } = build('VIEWER');

    const res = await gateway.onSubscribeWorkspace(asSocket, {
      workspaceId: WS,
    });

    expect(res).toEqual({ ok: true });
    expect(getRole).toHaveBeenCalledWith(WS, 'u1');
    expect(socket.join).toHaveBeenCalledWith(`workspace:${WS}`);
  });

  it('subscribe:workspace is refused when getRole returns null (deleted workspace or REMOVED member)', async () => {
    const { gateway, socket, asSocket, getRole } = build(null);

    const res = await gateway.onSubscribeWorkspace(asSocket, {
      workspaceId: OTHER_WS,
    });

    expect(res).toEqual({ ok: false, reason: 'forbidden' });
    expect(getRole).toHaveBeenCalledWith(OTHER_WS, 'u1');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('subscribe:workspace is refused when the role lookup throws', async () => {
    const { gateway, socket, asSocket, getRole } = build();
    getRole.mockRejectedValue(new Error('db down'));

    const res = await gateway.onSubscribeWorkspace(asSocket, {
      workspaceId: WS,
    });

    expect(res).toEqual({ ok: false, reason: 'forbidden' });
    expect(socket.join).not.toHaveBeenCalled();
  });
});
