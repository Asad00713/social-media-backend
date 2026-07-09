import { ConflictException, BadRequestException } from '@nestjs/common';
import { WhatsAppOnboardingService } from './whatsapp-onboarding.service';

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

  it('allows re-connecting a number already in the SAME workspace (delegates to createChannel)', async () => {
    const { service, channels } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest
          .fn()
          .mockResolvedValue([{ id: 9, workspaceId: 'ws-A' }]),
        createChannel: jest.fn().mockResolvedValue({ id: 9, accountName: 'Acme' }),
      },
    });
    const res = await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(res).toEqual({ id: 9, accountName: 'Acme' });
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
