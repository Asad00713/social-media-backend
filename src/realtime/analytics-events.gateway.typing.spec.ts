import { AnalyticsEventsGateway } from './analytics-events.gateway';

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

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONV2 = '33333333-3333-4333-8333-333333333333';
const ROOM = `workspace:${WS}`;

type TypingSocket = Parameters<AnalyticsEventsGateway['onInboxTyping']>[0];
type TypingMsg = Parameters<AnalyticsEventsGateway['onInboxTyping']>[1];

interface FakeSocket {
  id: string;
  userId: string | undefined;
  rooms: Set<string>;
  to: jest.Mock;
}

function build(role: string | null = 'MEMBER') {
  const getRole = jest.fn().mockResolvedValue(role);
  const gateway = new AnalyticsEventsGateway(
    {} as never,
    {} as never,
    { getRole } as never,
  );
  const serverEmit = jest.fn();
  const serverTo = jest.fn(() => ({ emit: serverEmit }));
  gateway.server = { to: serverTo } as never;
  const emit = jest.fn();
  const fake: FakeSocket = {
    id: 's1',
    userId: 'u1',
    rooms: new Set([ROOM]),
    to: jest.fn(() => ({ emit })),
  };
  const socket = fake as unknown as TypingSocket;
  return { gateway, socket, fake, emit, serverEmit, serverTo, getRole };
}

const msg = (over: Record<string, unknown> = {}): TypingMsg =>
  ({
    workspaceId: WS,
    conversationId: CONV,
    state: 'start',
    ...over,
  }) as TypingMsg;

describe('AnalyticsEventsGateway inbox:typing', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00Z'));
    findUser.mockReset();
    findUser.mockResolvedValue({ id: 'u1', name: 'Ann', avatarUrl: null });
  });
  afterEach(() => jest.useRealTimers());

  it('relays to teammates via socket.to(room), never the sender', async () => {
    const { gateway, socket, fake, emit, serverEmit, serverTo } = build();
    await expect(gateway.onInboxTyping(socket, msg())).resolves.toEqual({
      ok: true,
    });
    expect(fake.to).toHaveBeenCalledWith(ROOM);
    expect(emit).toHaveBeenCalledWith('inbox.typing', {
      workspaceId: WS,
      conversationId: CONV,
      user: { id: 'u1', name: 'Ann', avatarUrl: null },
      state: 'start',
    });
    expect(serverTo).not.toHaveBeenCalled();
    expect(serverEmit).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated socket', async () => {
    const { gateway, socket, fake, emit } = build();
    fake.userId = undefined;
    const r = await gateway.onInboxTyping(socket, msg());
    expect(r.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a socket that has not joined the room', async () => {
    const { gateway, socket, fake, emit } = build();
    fake.rooms = new Set();
    const r = await gateway.onInboxTyping(socket, msg());
    expect(r).toEqual({ ok: false, reason: 'not_subscribed' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a GUEST (no inbox:reply)', async () => {
    const { gateway, socket, emit } = build('GUEST');
    await expect(gateway.onInboxTyping(socket, msg())).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a user who has no role in the workspace', async () => {
    const { gateway, socket, emit } = build(null);
    const r = await gateway.onInboxTyping(socket, msg());
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ['bad state', { state: 'typing' }],
    ['non-uuid conversation', { conversationId: 'nope' }],
    ['missing workspace', { workspaceId: undefined }],
  ])('rejects invalid input: %s', async (_n, over) => {
    const { gateway, socket, emit } = build();
    const r = await gateway.onInboxTyping(socket, msg(over));
    expect(r.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('drops a second start within 1s, allows it after, per conversation', async () => {
    const { gateway, socket, emit } = build();
    await gateway.onInboxTyping(socket, msg());
    await gateway.onInboxTyping(socket, msg());
    expect(emit).toHaveBeenCalledTimes(1);
    await gateway.onInboxTyping(socket, msg({ conversationId: CONV2 }));
    expect(emit).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1000);
    await gateway.onInboxTyping(socket, msg());
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('stop always relays, even right after a start', async () => {
    const { gateway, socket, emit } = build();
    await gateway.onInboxTyping(socket, msg());
    await gateway.onInboxTyping(socket, msg({ state: 'stop' }));
    await gateway.onInboxTyping(socket, msg({ state: 'stop' }));
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith(
      'inbox.typing',
      expect.objectContaining({ state: 'stop' }),
    );
  });

  it('looks the user up once per socket', async () => {
    const { gateway, socket } = build();
    await gateway.onInboxTyping(socket, msg());
    jest.advanceTimersByTime(2000);
    await gateway.onInboxTyping(socket, msg());
    expect(findUser).toHaveBeenCalledTimes(1);
  });
});
