import { fetch as undiciFetch } from 'undici';

// DM attachment URLs come from the request body (DmAttachmentDto.url): the
// download must go through the SSRF guard (fetchPublicMedia → undici +
// publicAgent), never the unguarded global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { publicAgent } from '../../common/net/public-fetch';
import type { SlackService } from '../../channels/services/slack.service';
import type { TelegramService } from '../../channels/services/telegram.service';
import { DiscordService } from '../../channels/services/discord.service';
import { SlackDmAdapter } from './slack-dm.adapter';
import { TelegramDmAdapter } from './telegram-dm.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const PRIVATE_URLS = [
  'http://127.0.0.1/a.png',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.8/a.png',
  'http://[::1]/a.png',
];
const PUBLIC_URL = 'https://93.184.216.34/a.png';
const channel = { accessToken: 'tok' } as unknown as ResolvedChannel;
const att = (url: string) => ({
  kind: 'image' as const,
  url,
  contentType: 'image/png',
});

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
});
afterEach(() => jest.restoreAllMocks());

describe('Slack DM attachments', () => {
  const uploadFile = jest.fn();
  const adapter = new SlackDmAdapter({
    uploadFile,
  } as unknown as SlackService);

  it.each(PRIVATE_URLS)('refuses %s and uploads nothing', async (url) => {
    await expect(
      adapter.sendDmWithAttachments(channel, 'C1', 'hi', [att(url)]),
    ).rejects.toThrow();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('downloads a public URL through the pinned agent', async () => {
    mockedFetch.mockResolvedValue(new Response('png'));
    uploadFile.mockRejectedValue(new Error('stop here'));
    await adapter
      .sendDmWithAttachments(channel, 'C1', 'hi', [att(PUBLIC_URL)])
      .catch(() => undefined);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { dispatcher: unknown },
    ];
    expect(url).toBe(PUBLIC_URL);
    expect(init.dispatcher).toBe(publicAgent);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('Telegram DM attachments', () => {
  const sendPhoto = jest.fn();
  const adapter = new TelegramDmAdapter({
    forToken: () => ({ sendPhoto }),
  } as unknown as TelegramService);

  it.each(PRIVATE_URLS)('refuses %s and sends nothing', async (url) => {
    await expect(
      adapter.sendDmWithAttachments(channel, '42', 'hi', [att(url)]),
    ).rejects.toThrow();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

describe('Discord attachment download', () => {
  const discord = new DiscordService();

  it.each(PRIVATE_URLS)('refuses %s', async (url) => {
    await expect(discord.downloadAttachment(url)).rejects.toThrow();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('downloads a public URL through the pinned agent', async () => {
    mockedFetch.mockResolvedValue(
      new Response('png', { headers: { 'content-type': 'image/png' } }),
    );
    const out = await discord.downloadAttachment(PUBLIC_URL);
    expect(out.contentType).toBe('image/png');
    const [, init] = mockedFetch.mock.calls[0] as [
      string,
      { dispatcher: unknown },
    ];
    expect(init.dispatcher).toBe(publicAgent);
  });
});
