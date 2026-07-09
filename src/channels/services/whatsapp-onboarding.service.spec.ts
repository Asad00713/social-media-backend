import { ConflictException, BadRequestException } from '@nestjs/common';
import { WhatsAppOnboardingService } from './whatsapp-onboarding.service';
import { isChannelHealthy } from './channel.service';

function makeService(overrides: {
  whatsapp?: Partial<any>;
  channels?: Partial<any>;
  inbox?: Partial<any>;
} = {}) {
  const whatsapp = {
    exchangeCodeForBusinessToken: jest.fn().mockResolvedValue({ accessToken: 'biz', expiresIn: 5184000 }),
    getWabaPhoneNumbers: jest.fn().mockResolvedValue([
      { id: '111', displayPhoneNumber: '+1 555', verifiedName: 'Acme' },
    ]),
    registerPhoneNumber: jest.fn().mockResolvedValue(undefined),
    subscribeWaba: jest.fn().mockResolvedValue(undefined),
    ...overrides.whatsapp,
  };
  const channels = {
    findChannelsByPlatformAccountAllWorkspaces: jest.fn().mockResolvedValue([]),
    createChannel: jest.fn().mockResolvedValue({ id: 1, accountName: 'Acme' }),
    ...overrides.channels,
  };
  const inbox = {
    assertWorkspaceAccessPublic: jest.fn().mockResolvedValue(undefined),
    ...overrides.inbox,
  };
  const service = new WhatsAppOnboardingService(whatsapp as any, channels as any, inbox as any);
  return { service, whatsapp, channels, inbox };
}

describe('WhatsAppOnboardingService.completeEmbeddedSignup', () => {
  const input = { code: 'c', wabaId: 'w1', phoneNumberId: '111' };

  it('runs the full happy path and creates the channel', async () => {
    const { service, whatsapp, channels } = makeService();
    const res = await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(whatsapp.exchangeCodeForBusinessToken).toHaveBeenCalledWith('c');
    expect(whatsapp.registerPhoneNumber).toHaveBeenCalledWith('biz', '111', '000000');
    expect(whatsapp.subscribeWaba).toHaveBeenCalledWith('biz', 'w1');
    expect(channels.createChannel).toHaveBeenCalledWith(
      'ws-A',
      'u1',
      expect.objectContaining({
        platform: 'whatsapp',
        platformAccountId: '111',
        accessToken: 'biz',
        metadata: expect.objectContaining({ wabaId: 'w1', connectMethod: 'embedded_signup' }),
      }),
    );
    expect(res).toEqual({ id: 1, accountName: 'Acme' });
  });

  it('passes a caller-supplied pin through to register', async () => {
    const { service, whatsapp } = makeService();
    await service.completeEmbeddedSignup('ws-A', 'u1', { ...input, pin: '654321' });
    expect(whatsapp.registerPhoneNumber).toHaveBeenCalledWith('biz', '111', '654321');
  });

  it('rejects when the phone number is already connected in another workspace', async () => {
    const { service, whatsapp } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest
          .fn()
          .mockResolvedValue([{ id: 9, workspaceId: 'ws-OTHER' }]),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toBeInstanceOf(ConflictException);
    // The guard must short-circuit before any mutating Meta call.
    expect(whatsapp.exchangeCodeForBusinessToken).not.toHaveBeenCalled();
  });

  it('rejects a HEALTHY same-workspace duplicate before any Meta call', async () => {
    const { service, whatsapp } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest.fn().mockResolvedValue([
          { id: 9, workspaceId: 'ws-A', connectionStatus: 'connected', isActive: true, tokenExpiresAt: null },
        ]),
      },
    });
    await expect(service.completeEmbeddedSignup('ws-A', 'u1', input)).rejects.toBeInstanceOf(ConflictException);
    expect(whatsapp.exchangeCodeForBusinessToken).not.toHaveBeenCalled();
    expect(whatsapp.registerPhoneNumber).not.toHaveBeenCalled();
    expect(whatsapp.subscribeWaba).not.toHaveBeenCalled();
  });

  it('lets a BROKEN same-workspace channel through so createChannel can reconnect it', async () => {
    const { service, whatsapp, channels } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest.fn().mockResolvedValue([
          { id: 9, workspaceId: 'ws-A', connectionStatus: 'disconnected', isActive: false, tokenExpiresAt: null },
        ]),
        createChannel: jest.fn().mockResolvedValue({ id: 9, accountName: 'Acme' }),
      },
    });
    const res = await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(whatsapp.exchangeCodeForBusinessToken).toHaveBeenCalled();
    expect(channels.createChannel).toHaveBeenCalled();
    expect(res).toEqual({ id: 9, accountName: 'Acme' });
  });

  it('lets an EXPIRED-token same-workspace channel through (unhealthy)', async () => {
    const { service, channels } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest.fn().mockResolvedValue([
          { id: 9, workspaceId: 'ws-A', connectionStatus: 'connected', isActive: true, tokenExpiresAt: new Date(Date.now() - 1000) },
        ]),
        createChannel: jest.fn().mockResolvedValue({ id: 9, accountName: 'Acme' }),
      },
    });
    await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(channels.createChannel).toHaveBeenCalled();
  });

  it('surfaces an expired/invalid code as a BadRequest', async () => {
    const { service } = makeService({
      whatsapp: {
        exchangeCodeForBusinessToken: jest.fn().mockRejectedValue(new Error('Invalid code')),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails the connect when WABA subscribe fails (blocking, not best-effort)', async () => {
    const { service, channels } = makeService({
      whatsapp: {
        subscribeWaba: jest.fn().mockRejectedValue(new Error('subscribe boom')),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toThrow('subscribe boom');
    // No persistence should occur when subscribe fails before createChannel.
    expect(channels.createChannel).not.toHaveBeenCalled();
  });
});

describe('isChannelHealthy', () => {
  it('is true when connected, active, and never expires', () => {
    expect(
      isChannelHealthy({
        connectionStatus: 'connected',
        isActive: true,
        tokenExpiresAt: null,
      }),
    ).toBe(true);
  });

  it('is false when disconnected', () => {
    expect(
      isChannelHealthy({
        connectionStatus: 'disconnected',
        isActive: true,
        tokenExpiresAt: null,
      }),
    ).toBe(false);
  });

  it('is false when inactive', () => {
    expect(
      isChannelHealthy({
        connectionStatus: 'connected',
        isActive: false,
        tokenExpiresAt: null,
      }),
    ).toBe(false);
  });

  it('is false when the token has already expired', () => {
    expect(
      isChannelHealthy({
        connectionStatus: 'connected',
        isActive: true,
        tokenExpiresAt: new Date(Date.now() - 1000),
      }),
    ).toBe(false);
  });

  it('is true when the token expires in the future', () => {
    expect(
      isChannelHealthy({
        connectionStatus: 'connected',
        isActive: true,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe(true);
  });
});
