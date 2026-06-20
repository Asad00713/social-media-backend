process.env.TELEGRAM_WEBHOOK_HMAC_SECRET = 'test-secret';
process.env.TELEGRAM_WEBHOOK_BASE_URL = 'https://api.example.com';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TelegramConnectService } from './telegram-connect.service';

function makeClient(overrides: any = {}) {
  return {
    getMe: jest.fn().mockResolvedValue({ id: 555, is_bot: true, first_name: 'My Bot', username: 'my_bot' }),
    setWebhook: jest.fn().mockResolvedValue(true),
    getWebhookInfo: jest.fn().mockResolvedValue({ url: 'https://api.example.com/webhooks/telegram/x' }),
    getUserProfilePhotoFileId: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('TelegramConnectService.connect', () => {
  let telegram: any;
  let channelService: any;
  let assertAccess: jest.Mock;
  let svc: TelegramConnectService;

  beforeEach(() => {
    telegram = { forToken: jest.fn() };
    channelService = {
      findChannelByPlatformAccountGlobal: jest.fn().mockResolvedValue(null),
      createChannel: jest.fn().mockResolvedValue({ id: 10, platform: 'telegram' }),
    };
    assertAccess = jest.fn().mockResolvedValue(undefined);
    svc = new TelegramConnectService(telegram, channelService, { assertWorkspaceAccessPublic: assertAccess } as any);
  });

  it('rejects an invalid token', async () => {
    telegram.forToken.mockReturnValue(makeClient({ getMe: jest.fn().mockRejectedValue(new Error('401')) }));
    await expect(svc.connect('ws', 'u', 'bad')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a bot already connected anywhere (409)', async () => {
    telegram.forToken.mockReturnValue(makeClient());
    channelService.findChannelByPlatformAccountGlobal.mockResolvedValue({ id: 99 });
    await expect(svc.connect('ws', 'u', 'tok')).rejects.toBeInstanceOf(ConflictException);
  });

  it('sets the webhook and creates an encrypted channel row', async () => {
    const client = makeClient();
    telegram.forToken.mockReturnValue(client);
    const res = await svc.connect('ws', 'u', 'tok');
    expect(client.setWebhook).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.example\.com\/webhooks\/telegram\/[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    const dto = channelService.createChannel.mock.calls[0][2];
    expect(dto.platform).toBe('telegram');
    expect(dto.platformAccountId).toBe('555');
    expect(dto.username).toBe('my_bot');
    expect(dto.telegramWebhookRouteId).toMatch(/^[0-9a-f]{32}$/);
    expect(res).toEqual({ id: 10, platform: 'telegram' });
  });
});
